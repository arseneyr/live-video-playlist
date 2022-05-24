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

type GetNextVideoSync = Iterable<IVideo> | (() => IVideo | null);
type GetNextVideoAsync =
  | AsyncIterable<IVideo>
  | (() => PromiseLike<IVideo | null>);

type GetNextVideo = GetNextVideoSync | GetNextVideoAsync;

type Placeholder = Pick<IVideo, "hlsPlaylist" | "onPlay">;

type LiveVideoPlaylistOptions = {
  targetDuration: number;
  getNextVideo: GetNextVideoSync;
  fallbackPlaceholder?: never;
  unreachableUri?: never;
} | {
  targetDuration: number;
  getNextVideo: GetNextVideoAsync;
  fallbackPlaceholder: Placeholder | (() => Placeholder);
  unreachableUri?: never;
} | {
  targetDuration: number;
  getNextVideo: GetNextVideoAsync;
  fallbackPlaceholder?: never;
  unreachableUri: string;
};

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

function isParsedVideo(v: unknown): v is ParsedVideo {
  return v !== null && typeof v === "object" && "hlsPlaylist" in v;
}

async function* videoGenerator(
  fn: GetNextVideo,
  mustBeSync: boolean,
) {
  if (isAsyncIterable(fn) || isIterable(fn)) {
    return yield* fn;
  }
  for (;;) {
    const p = fn();
    if (!p) {
      return;
    }
    if (mustBeSync && !("hlsPlaylist" in p)) {
      throw new Error(
        "async getNextVideo requires fallbackPlaceholder or unreachableUri",
      );
    }
    const v = await p;
    if (!v) {
      return;
    }
    yield v;
  }
}

function getSegmentsDurationMs(s: Iterable<{ segment: HLSSegment }>): number {
  return Array.from(s).reduce(
    (acc, cur) => acc + cur.segment.duration * 1000,
    0,
  );
}

function* placeholderGenerator(
  placeholder: string | (() => ParsedVideo),
  targetDuration: number,
): Generator<ParsedSegment> {
  if (typeof placeholder === "function") {
    for (const v = placeholder();;) {
      yield* segmentsFromVideo(v);
    }
  } else {
    for (let i = 0;; ++i) {
      yield {
        segment: new HLS.types.Segment({
          uri: placeholder,
          duration: targetDuration,
          mediaSequenceNumber: 0,
          discontinuitySequence: 0,
        }),
        first: i === 0,
      };
    }
  }
}

function* segmentsFromVideo(
  video: ParsedVideo,
): Generator<ParsedSegment, ParsedVideo | void, ParsedVideo | unknown> {
  for (let i = 0; i < video.hlsPlaylist.segments.length; i++) {
    const segment: HLSSegment = video.hlsPlaylist.segments[i];
    if (i === 0) {
      segment.discontinuity = true;
    }
    const pendingVideo = yield {
      segment,
      first: i === 0,
      onPlay: video.onPlay,
      onComplete: video.onComplete,
    };
    if (isParsedVideo(pendingVideo)) {
      return pendingVideo;
    }
  }
}

async function* segmentGenerator(
  getNextVideo: GetNextVideo,
  targetDuration: number,
  parseVideo: (v: IVideo) => ParsedVideo | null,
  placeholder?: (() => ParsedVideo) | string,
): AsyncGenerator<ParsedSegment, void, ParsedVideo | void> {
  const videoIterator = videoGenerator(
    getNextVideo,
    placeholder === undefined,
  );
  for (let video: ParsedVideo | void;;) {
    if (!video) {
      const p = videoIterator.next();
      const placeholderIterable = placeholder
        ? placeholderGenerator(placeholder, targetDuration)
        : [null];
      for (
        const curPlaceholder of placeholderIterable
      ) {
        const v = await Promise.race([p, delay(0).then(() => true as const)]);
        if (v === true) {
          // p will reject if placeholder is undefined and getNextVideo is async
          asserts.assert(curPlaceholder);

          video = yield curPlaceholder;
        } else if (v.done) {
          return;
        } else {
          video = parseVideo(v.value) ?? undefined;
        }
        if (video) {
          break;
        }
      }
    }
    asserts.assert(video);
    video = yield* segmentsFromVideo(video);
  }
}

function livePlaylist(options: LiveVideoPlaylistOptions) {
  const { targetDuration } = options;
  if (
    !Number.isInteger(targetDuration) ||
    targetDuration < 1
  ) {
    throw new Error("target duration must be a positive integer");
  }
  if (
    isAsyncIterable(options.getNextVideo) && !options.fallbackPlaceholder &&
    !options.unreachableUri
  ) {
    throw new Error(
      "async getNextVideo must have fallback placeholder or unreachable URI",
    );
  }

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
  function parseVideo(video: IVideo): ParsedVideo | null {
    try {
      return {
        hlsPlaylist: parseHlsPlaylist(video.hlsPlaylist),
        onPlay: video.onPlay,
        onComplete: video.onComplete,
        onError: video.onError,
      };
    } catch (err) {
      if (video.onError) {
        video.onError(err);
      } else {
        console.warn("failed to parse playlist: " + err.message);
      }
    }
    return null;
  }

  let placeholder: string | (() => ParsedVideo) | undefined;
  try {
    if ("unreachableUri" in options) {
      placeholder = options.unreachableUri;
    } else if (typeof options.fallbackPlaceholder === "object") {
      const parsedPlaceholder = {
        hlsPlaylist: parseHlsPlaylist(
          options.fallbackPlaceholder.hlsPlaylist,
        ),
        onPlay: options.fallbackPlaceholder.onPlay,
      };
      placeholder = () => parsedPlaceholder;
    } else if (typeof options.fallbackPlaceholder === "function") {
      const fn = options.fallbackPlaceholder;
      placeholder = () => {
        const v = fn();
        return {
          hlsPlaylist: parseHlsPlaylist(v.hlsPlaylist),
          onPlay: v.onPlay,
        };
      };
    }
  } catch (err) {
    throw new Error("failed to parse placeholder playlist: " + err.message);
  }

  const segmentIterator = segmentGenerator(
    options.getNextVideo,
    targetDuration,
    parseVideo,
    placeholder,
  );
  let pendingVideo: ParsedVideo | null = null;
  function playNext(video: IVideo) {
    pendingVideo = parseVideo(video);
  }
  const getNextSegment = async () => {
    let segment;
    do {
      let p;
      if (pendingVideo) {
        p = pendingVideo;
        pendingVideo = null;
      }
      const ir = await segmentIterator.next(p);
      if (ir.done) {
        return null;
      }
      segment = ir.value;
    } while (pendingVideo);
    return segment;
  };

  type SegmentDescriptor = ParsedSegment & {
    addedToPlaylistMs: number;
    availabilityDurationMs: number;
    startTimeMs: number;
  };
  let discontinuitySequence = 0;
  let mediaSequenceNumber = 0;
  let segments: SegmentDescriptor[] = [];
  let nextUpdate: ReturnType<typeof setTimeout> | null = null;

  async function fillPlaylist(
    minLengthMs: number,
  ) {
    const ret: SegmentDescriptor[] = [];
    while (
      getSegmentsDurationMs(ret) < minLengthMs
    ) {
      const s = await getNextSegment();
      if (!s) {
        break;
      }
      s.segment.mediaSequenceNumber = mediaSequenceNumber++;
      if (s.segment.discontinuity) {
        discontinuitySequence++;
      }
      s.segment.discontinuitySequence = discontinuitySequence;
      ret.push({
        ...s,
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

  return { start, playNext };
}

export default livePlaylist;
