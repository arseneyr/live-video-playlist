import { asserts, HLS } from "./deps.ts";

// https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.2
const MIN_PLAYLIST_TD_MULTIPLE = 3;

type HLSPlaylist = HLS.types.MediaPlaylist;
type HLSSegment = HLS.types.Segment;

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

function mapNext<T, U, R, N>(
  asyncIterator: AsyncIterator<T, R, N>,
  mapFn: (item: T) => U,
): AsyncIterator<U, R, N> {
  return {
    ...asyncIterator,
    next: async (...args) => {
      const { done, value } = await asyncIterator.next(...args);
      if (!done) {
        return { done, value: mapFn(value) };
      }
      return { done, value };
    },
  } as AsyncIterator<U, R, N>;
}

function filter<T, R, N, S extends T>(
  asyncIterator: AsyncIterator<T, R, N>,
  filterFn: (item: T) => item is S,
): AsyncIterator<S, R, N> {
  return {
    ...asyncIterator,
    next: async (...args) => {
      let val = await asyncIterator.next(...args);
      while (!val.done && !filterFn(val.value)) {
        val = await asyncIterator.next(...args);
      }
      return val;
    },
  } as AsyncIterator<S, R, N>;
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

function getVideoOrFallback(
  video: Promise<IVideo>,
  fallback: HLSSegment,
): Promise<IVideo | HLSSegment> {
  return Promise.race([
    video,
    new Promise<HLSSegment>((res) => setTimeout(() => res(fallback))),
  ]);
}

function livePlaylist(options: LiveVideoPlaylistOptions) {
  const { targetDuration } = options;
  if (
    !Number.isInteger(targetDuration) ||
    targetDuration < 1
  ) {
    throw new Error("target duration must be a positive integer");
  }
  const videoIterable = (async function* () {
    for await (let v of getNextVideo(options.getNextVideo)) {
      try {
        yield {
          ...v,
          hlsPlaylist: parseHlsPlaylist(v.hlsPlaylist),
        } as ParsedVideo;
      } catch (err) {
        v.onError?.(err);
      }
    }
  })();
  const placeholder = typeof options.fallbackPlaceholder === "string"
    ? options.fallbackPlaceholder
    : parseHlsPlaylist(options.fallbackPlaceholder.hlsPlaylist);

  const placeholderIterable = (function* () {
    for (let i = 0;; ++i) {
      if (typeof placeholder === "string") {
        yield new HLS.types.Segment({
          uri: placeholder,
          duration: targetDuration,
          mediaSequenceNumber: 0,
          discontinuitySequence: 0,
        });
      } else {
        const segments = placeholder.segments;
        yield segments[i % segments.length];
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
    if (parsedPlaylist.targetDuration > targetDuration) {
      throw new Error(
        "playlist target duration longer than configured target duration",
      );
    }
    return parsedPlaylist;
  }

  let pendingVideo: ParsedVideo | null = null;
}
