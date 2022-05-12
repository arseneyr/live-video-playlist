import { asserts } from "./deps.ts";
import livePlaylist from "./main.ts";

Deno.test("invalid target duration", async () => {
  const createFakeOptions = (targetDuration: number) => ({
    getNextVideo: () => ({ hlsPlaylist: "" }),
    fallbackPlaceholder: "",
    targetDuration,
  });
  await asserts.assertRejects(() => livePlaylist(createFakeOptions(0)));
  await asserts.assertRejects(() => livePlaylist(createFakeOptions(1.5)));
});
