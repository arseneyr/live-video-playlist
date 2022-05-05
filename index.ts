import HLS, { types as hlsTypes } from "hls-parser";

type HLSPlaylist = hlsTypes.MediaPlaylist;

interface Video {
  hlsPlaylist: string;
  onPlay?: () => unknown;
  onError?: (err: Error) => unknown;
}

type ParsedVideo = Omit<Video, "hlsPlaylist"> & { hlsPlaylist: HLSPlaylist };

interface LiveVideoPlaylistOptions {
  targetDuration: number;
  getNextVideo(): Video | PromiseLike<Video>;
  fallbackPlaceholder?: Video;
}

function isMediaPlaylist(
  playlist: hlsTypes.Playlist
): playlist is hlsTypes.MediaPlaylist {
  return playlist.isMasterPlaylist;
}

class LiveVideoPlaylist {
  readonly #getNextVideo: () => Video | PromiseLike<Video>;
  readonly #targetDuration: number;
  readonly #fallbackPlaceholder?: ParsedVideo;

  constructor(options: LiveVideoPlaylistOptions) {
    HLS.setOptions({ strictMode: true });

    this.#getNextVideo = options.getNextVideo;
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
          options.fallbackPlaceholder.hlsPlaylist
        );
        this.#fallbackPlaceholder = {
          ...options.fallbackPlaceholder,
          hlsPlaylist,
        };
      } catch (err) {
        options.fallbackPlaceholder.onError?.(err);
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
        "playlist target duration longer than configured target duration"
      );
    }
    return parsedPlaylist;
  }
}
