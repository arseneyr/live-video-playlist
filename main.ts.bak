import { asserts, HLS } from "./deps.ts";

// https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.2
const MIN_PLAYLIST_TD_MULTIPLE = 3;

type HLSPlaylist = HLS.types.MediaPlaylist;

interface IVideo {
  hlsPlaylist: string;
  onPlay?: () => unknown;
  onError?: (err: Error) => unknown;
}

type ParsedVideo = Omit<IVideo, "hlsPlaylist"> & { hlsPlaylist: HLSPlaylist };

type GetNextVideo =
  | AsyncIterable<IVideo>
  | Iterable<IVideo>
  | (() => IVideo | null | PromiseLike<IVideo | null>);

interface LiveVideoPlaylistOptions {
  targetDuration: number;
  getNextVideo: GetNextVideo;
  fallbackPlaceholder: IVideo | string;
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
  return playlist.isMasterPlaylist;
}

function assertIterValue<T>(
  i: IteratorResult<T>,
): asserts i is IteratorYieldResult<T> {
  if (i.done === true) {
    throw new Error("iterator improperly finished");
  }
}

class LiveVideoPlaylist {
  readonly #targetDuration: number;
  readonly #fallbackPlaceholder: ParsedVideo | string;
  readonly #videoIterator: AsyncIterator<IVideo>;

  #segments: HLS.types.Segment[] = [];
  #mediaSequence = 0;
  #discontinuitySequence = 0;
  #currentVideo?: AsyncIterator<HLS.types.Segment>;

  constructor(options: LiveVideoPlaylistOptions) {
    HLS.setOptions({ strictMode: true });

    this.#videoIterator = this.#getNextVideo(options.getNextVideo);
    this.#targetDuration = options.targetDuration;
    if (
      !Number.isInteger(options.targetDuration) ||
      options.targetDuration < 1
    ) {
      throw new Error("target duration must be a positive integer");
    }
    if (typeof options.fallbackPlaceholder === "string") {
      this.#fallbackPlaceholder = options.fallbackPlaceholder;
    } else {
      const hlsPlaylist = this.#parseHlsPlaylist(
        options.fallbackPlaceholder.hlsPlaylist,
      );
      this.#fallbackPlaceholder = {
        ...options.fallbackPlaceholder,
        hlsPlaylist,
      };
    }
  }

  get #segmentsDuration() {
    return this.#segments.reduce((acc, cur) => acc + cur.duration, 0);
  }

  async #fillSegments() {
    while (
      this.#segmentsDuration < (this.#targetDuration * MIN_PLAYLIST_TD_MULTIPLE)
    ) {
    }
  }

  async *#getNextSegment(): AsyncGenerator<
    HLS.types.Segment,
    void,
    IVideo | undefined
  > {
    const getVideoOrFallback = (
      video: Promise<IteratorResult<IVideo>>,
      fallback: Iterator<HLS.types.Segment>,
    ) => {
      return Promise.race([
        video,
        new Promise<HLS.types.Segment>((res) =>
          setTimeout(() => {
            const seg = fallback.next();
            asserts.assert(!seg.done);
            res(seg.value);
          })
        ),
      ]);
    };
    let currentVideoPromise = this.#videoIterator.next();
    for (;;) {
      const placeholderIterator = this.#getPlaceholder();
      let newVid: IVideo | undefined;
      let segmentOrVideo: HLS.types.Segment | IteratorResult<IVideo>;
      for (
        segmentOrVideo = await getVideoOrFallback(
          currentVideoPromise,
          placeholderIterator,
        );
        segmentOrVideo instanceof HLS.types.Segment;
        segmentOrVideo = await getVideoOrFallback(
          currentVideoPromise,
          placeholderIterator,
        )
      ) {
        if (segmentOrVideo.mediaSequenceNumber === 0) {
          segmentOrVideo.discontinuitySequence = this.#discontinuitySequence++;
          segmentOrVideo.discontinuity = true;
        }
        newVid = yield segmentOrVideo;
        if (newVid) {
          break;
        }
      }
      if ("done" in segmentOrVideo && segmentOrVideo.done) {
        return;
      }
      if (newVid) {
        currentVideoPromise = Promise.resolve({ done: false, value: newVid });
        continue;
      }
      asserts.assert("value" in segmentOrVideo);
      try {
        const playlist = this.#parseHlsPlaylist(
          segmentOrVideo.value.hlsPlaylist,
        );
        for (
          let i = 0;
          i < playlist.segments.length && newVid === undefined;
          ++i
        ) {
          newVid = yield playlist.segments[i];
        }
      } catch (err) {
        segmentOrVideo.value.onError?.(err);
      }

      currentVideoPromise = this.#videoIterator.next();
    }
  }

  async *#getNextVideo(fn: GetNextVideo) {
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

  *#getPlaceholder() {
    for (let i = 0;; ++i) {
      if (typeof this.#fallbackPlaceholder === "string") {
        const segment = new HLS.types.Segment({
          uri: this.#fallbackPlaceholder,
          duration: this.#targetDuration,
          mediaSequenceNumber: 0,
          discontinuitySequence: 0,
        });
      } else {
        const segments = this.#fallbackPlaceholder.hlsPlaylist.segments;
        yield segments[i % segments.length];
      }
    }
  }

  #parseHlsPlaylist(playlist: string): HLSPlaylist {
    const parsedPlaylist = HLS.parse(playlist);
    if (!isMediaPlaylist(parsedPlaylist)) {
      throw new Error("only media playlists supported");
    }
    if (parsedPlaylist.targetDuration > this.#targetDuration) {
      throw new Error(
        "playlist target duration longer than configured target duration",
      );
    }
    return parsedPlaylist;
  }
}

export default LiveVideoPlaylist;
