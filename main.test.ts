import { asserts, delay, HLS } from "./deps.ts";
import livePlaylist from "./main.ts";

const samplePlaylist = HLS.stringify(
  new HLS.types.MediaPlaylist({
    targetDuration: 1,
    segments: [
      new HLS.types.Segment({
        uri: "yo",
        duration: 1,
        mediaSequenceNumber: 0,
        discontinuitySequence: 0,
      }),
    ],
  }),
);

Deno.test("invalid target duration", () => {
  const createFakeOptions = (targetDuration: number) => ({
    getNextVideo: () => ({ hlsPlaylist: "" }),
    fallbackPlaceholder: "",
    targetDuration,
  });
  asserts.assertThrows(
    () => livePlaylist(createFakeOptions(0)),
    Error,
    "target duration",
  );
  asserts.assertThrows(
    () => livePlaylist(createFakeOptions(1.5)),
    Error,
    "target duration",
  );
});

Deno.test("invalid placeholder playlist", () => {
  const createFakeOptions = () => ({
    getNextVideo: () => ({ hlsPlaylist: "" }),
    fallbackPlaceholder: {
      hlsPlaylist: "",
    },
    targetDuration: 1,
  });
  asserts.assertThrows(
    () => livePlaylist(createFakeOptions()),
    Error,
    "placeholder",
  );
});
Deno.test("pending getNextVideo without placeholder", async () => {
  const nextVideoPromise = delay(0).then(() => ({
    hlsPlaylist: samplePlaylist,
  }));
  const createFakeOptions = () => ({
    getNextVideo: async () => ({ hlsPlaylist: samplePlaylist }),
    targetDuration: 1,
  });
  const { start } = livePlaylist(createFakeOptions());
  await asserts.assertRejects(
    start,
    Error,
    "pending",
  );
  await nextVideoPromise;
});
