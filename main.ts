import { asserts, delay, HLS } from "./deps.ts";

HLS.setOptions({ strictMode: true });

// https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.2
const MIN_PLAYLIST_TD_MULTIPLE = 3;

type HLSPlaylist = HLS.types.MediaPlaylist;
type HLSSegment = HLS.types.Segment;

interface IVideo {
  hlsPlaylist: string;
  onPlay?: () => unknown;
  onComplete?: (segmentUri: string, lastSegment: boolean) => unknown;
  onError?: (err: Error) => unknown;
}

type ParsedVideo = Omit<IVideo, "hlsPlaylist"> & { hlsPlaylist: HLSPlaylist };
type ParsedSegment = Pick<IVideo, "onPlay" | "onComplete"> & {
  segment: HLSSegment;
  first: boolean;
};

type GetNextVideo =
  | AsyncIterable<IVideo>
  | Iterable<IVideo>
  | (() => IVideo | null | PromiseLike<IVideo | null>);

interface LiveVideoPlaylistOptions {
  targetDuration: number;
  getNextVideo: GetNextVideo;
  fallbackPlaceholder?: Pick<IVideo, "hlsPlaylist" | "onPlay"> | string;
}

function isIterable(x: any): x is Iterable<unknown> {
  return Symbol.iterator in x;
}

function isAsyncIterable(x: any): x is AsyncIterable<unknown> {
  return Symbol.asyncIterator in x;
}

function isMediaPlaylist(
  playlist: HLS.types.Playlist,
): playlist is HLS.types.MediaPlaylist {
  return playlist instanceof HLS.types.MediaPlaylist &&
    !playlist.isMasterPlaylist;
}

async function* getNextVideo(fn: GetNextVideo) {
  if (isAsyncIterable(fn) || isIterable(fn)) {
    return yield* fn;
  }
  for (;;) {
    const val = await fn();
    if (!val) {
      return;
    }
    yield val;
  }
}

function getSegmentsDurationMs(s: Iterable<{ segment: HLSSegment }>): number {
  return Array.from(s).reduce(
    (acc, cur) => acc + cur.segment.duration * 1000,
    0,
  );
}

function* placeholderGenerator(
  placeholder: string | ParsedVideo,
  targetDuration: number,
): Generator<ParsedSegment> {
  for (let i = 0;; ++i) {
    if (typeof placeholder === "string") {
      yield {
        segment: new HLS.types.Segment({
          uri: placeholder,
          duration: targetDuration,
          mediaSequenceNumber: 0,
          discontinuitySequence: 0,
        }),
        first: i === 0,
      };
    } else {
      const segments = placeholder.hlsPlaylist.segments;
      if (i % segments.length === 0) {
        segments[0].discontinuity = true;
      }
      yield {
        segment: segments[i % segments.length],
        first: i === 0,
        onPlay: placeholder.onPlay,
      };
    }
  }
}

async function* segmentGenerator(
  videoIterator: AsyncIterator<ParsedVideo>,
  placeholderGenerator: Iterable<ParsedSegment> | null,
  checkPending: () => ParsedVideo | null,
) {
  for (let video = checkPending();;) {
    if (!video) {
      const errPromise = !placeholderGenerator
        ? delay(0).then(() => {
          throw new Error(
            "getNextVideo returned pending promise without placeholder",
          );
        })
        : undefined;
      const p = videoIterator.next();
      for (
        const curPlaceholder of placeholderGenerator ?? [null]
      ) {
        const raceArray = curPlaceholder === null
          ? [
            errPromise!,
            p,
          ]
          : [p, delay(0).then(() => curPlaceholder)];
        const v = await Promise.race(raceArray);
        video = checkPending();
        if (video) {
          break;
        }
        if ("segment" in v) {
          yield v;
        } else if (v.done) {
          return;
        } else {
          video = v.value;
          break;
        }
      }
    }
    asserts.assert(video);
    let pendingVideo = null;
    for (let i = 0; i < video.hlsPlaylist.segments.length; i++) {
      const segment = video.hlsPlaylist.segments[i];
      if (i === 0) {
        segment.discontinuity = true;
      }
      yield {
        segment,
        first: i === 0,
        onPlay: video.onPlay,
        onComplete: video.onComplete,
      };
      pendingVideo = checkPending();
      if (pendingVideo) {
        video = pendingVideo;
        break;
      }
    }
  }
}

function livePlaylist(options: LiveVideoPlaylistOptions) {
  const { targetDuration } = options;
  let pendingVideo: ParsedVideo | null = null;
  let discontinuitySequence = 0;
  let mediaSequenceNumber = 0;
  if (
    !Number.isInteger(targetDuration) ||
    targetDuration < 1
  ) {
    throw new Error("target duration must be a positive integer");
  }
  let placeholder: string | ParsedVideo | undefined;
  try {
    placeholder = (typeof options.fallbackPlaceholder === "string" ||
        !options.fallbackPlaceholder)
      ? options.fallbackPlaceholder
      : {
        ...options.fallbackPlaceholder,
        hlsPlaylist: parseHlsPlaylist(options.fallbackPlaceholder.hlsPlaylist),
      };
  } catch (err) {
    throw new Error("failed to parse placeholder playlist: " + err.message);
  }

  const userVideoIterable = (async function* () {
    for await (const v of getNextVideo(options.getNextVideo)) {
      try {
        yield {
          ...v,
          hlsPlaylist: parseHlsPlaylist(v.hlsPlaylist),
        } as ParsedVideo;
      } catch (err) {
        if (v.onError) {
          v.onError(err);
        } else {
          console.warn("failed to parse playlist: " + err.message);
        }
      }
    }
  })();
  function parseHlsPlaylist(
    playlist: string,
  ): HLSPlaylist {
    const parsedPlaylist = HLS.parse(playlist);
    if (!isMediaPlaylist(parsedPlaylist)) {
      throw new Error("only media playlists supported");
    }
    if (
      parsedPlaylist.segments.some((v) =>
        Math.round(v.duration) > targetDuration
      )
    ) {
      throw new Error(
        "playlist contains segments longer than configured target duration",
      );
    }
    return parsedPlaylist;
  }
  const segmentIterator = segmentGenerator(
    userVideoIterable,
    placeholder ? placeholderGenerator(placeholder, targetDuration) : null,
    () => {
      if (pendingVideo) {
        const v = pendingVideo;
        pendingVideo = null;
        return v;
      }
      return null;
    },
  );

  type SegmentDescriptor = ParsedSegment & {
    addedToPlaylistMs: number;
    availabilityDurationMs: number;
    startTimeMs: number;
  };
  let segments: SegmentDescriptor[] = [];
  let nextUpdate: ReturnType<typeof setTimeout> | null = null;

  async function fillPlaylist(
    minLengthMs: number,
  ) {
    const ret: SegmentDescriptor[] = [];
    while (
      getSegmentsDurationMs(ret) < minLengthMs
    ) {
      const s = await segmentIterator.next();
      if (s.done) {
        break;
      }
      s.value.segment.mediaSequenceNumber = mediaSequenceNumber++;
      if (s.value.segment.discontinuity) {
        discontinuitySequence++;
      }
      s.value.segment.discontinuitySequence = discontinuitySequence;
      ret.push({
        ...s.value,
        addedToPlaylistMs: 0,
        startTimeMs: 0,
        availabilityDurationMs: 0,
      });
    }
    return ret;
  }

  async function update() {
    const now = Date.now();
    const lastSegment = segments[segments.length - 1];
    const playlistEndTime = lastSegment
      ? lastSegment.startTimeMs +
        lastSegment.segment.duration * 1000
      : now;
    const fillAmount = Math.max(
      playlistEndTime - (targetDuration * MIN_PLAYLIST_TD_MULTIPLE * 1000),
      now,
    );
    const newSegs = await fillPlaylist(
      fillAmount,
    );
  }

  async function start() {
    const segs: SegmentDescriptor[] = await fillPlaylist(
      MIN_PLAYLIST_TD_MULTIPLE * targetDuration * 1000,
    );
    updateAvailabilityDurations(segs);
    segments = segs;
  }

  function updateAvailabilityDurations(segments: SegmentDescriptor[]) {
    const playlistDurationMs = getSegmentsDurationMs(segments);
    for (const s of segments) {
      const newAd = playlistDurationMs + (s.segment.duration * 1000);
      s.availabilityDurationMs = Math.max(s.availabilityDurationMs, newAd);
    }
  }

  function playNext(video: IVideo) {
    try {
      pendingVideo = {
        ...video,
        hlsPlaylist: parseHlsPlaylist(video.hlsPlaylist),
      };
    } catch (err) {
      video.onError?.(err);
    }
  }

  return { start, playNext };
}

export default livePlaylist;
