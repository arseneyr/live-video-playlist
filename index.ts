import HLS from "https://esm.sh/hls-parser@0.10.4?pin=v78";

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
  fallbackPlaceholder?: IVideo;
}

function isIterable(x: any): x is Iterable<unknown> {
  return Symbol.iterator in x;
}

function isAsyncIterable(x: any): x is AsyncIterable<unknown> {
  return Symbol.asyncIterator in x;
}

function mapAsyncIterable<T, U>(
  i: AsyncIterable<T>,
  fn: (item: T) => U,
): AsyncIterable<U> {
  return (async function* () {
    for await (const item of i) {
      yield fn(item);
    }
  })();
}

function isMediaPlaylist(
  playlist: HLS.types.Playlist,
): playlist is HLS.types.MediaPlaylist {
  return playlist.isMasterPlaylist;
}

class LiveVideoPlaylist {
  readonly #targetDuration: number;
  readonly #fallbackPlaceholder?: ParsedVideo;
  readonly #videoIterator: AsyncIterator<IVideo>;

  #segments: HLS.types.Segment[] = [];

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
    if (options.fallbackPlaceholder) {
      try {
        const hlsPlaylist = this.#parseHlsPlaylist(
          options.fallbackPlaceholder.hlsPlaylist,
        );
        this.#fallbackPlaceholder = {
          ...options.fallbackPlaceholder,
          hlsPlaylist,
        };
      } catch (err) {
        if (err instanceof Error) {
          options.fallbackPlaceholder.onError?.(err);
        } else {
          options.fallbackPlaceholder.onError?.(new Error("unknown error"));
        }
      }
    }
  }

  get #segmentsDuration() {
    return this.#segments.reduce((acc, cur) => acc + cur.duration, 0);
  }

  async #fillSegments() {
    while (this.#segmentsDuration < this.#targetDuration * 3) {
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

  async *#getPlaceholder() {}

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
