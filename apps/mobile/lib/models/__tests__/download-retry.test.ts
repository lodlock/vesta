// The retry policy, on its own.
//
// Nothing here knows about GenieX, and that is the point: which failures are
// worth retrying is a backend question (npu-errors.isTransientPullFailure),
// while how many times, how long to wait and whether the user wants it at all
// are not. Keeping them apart is what lets a second backend get its own
// classification without a second copy of the waiting and counting.

import { getConfig, setConfig } from "../../storage/database";
import {
  getDownloadRetrySettings,
  setDownloadRetrySettings,
  DEFAULT_DOWNLOAD_RETRY,
  RETRY_LIMIT_CHOICES,
  normalizeRetrySettings,
  retryAllowed,
  retryDelayMs,
  describeRetry,
  waitForRetry,
  type DownloadRetrySettings,
} from "../download-retry";

// The config table is the persistence detail; the policy is what is under test.
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null),
  setConfig: jest.fn(async () => {}),
}));

const settings = (over: Partial<DownloadRetrySettings> = {}) => ({
  ...DEFAULT_DOWNLOAD_RETRY,
  ...over,
});

describe("the default", () => {
  // On, because this is recovery from an interrupted transfer: the alternative
  // is a user watching 2.4 GB fail at 97% and pressing a button that does
  // exactly what this does.
  it("retries without being asked", () => {
    expect(DEFAULT_DOWNLOAD_RETRY.autoRetry).toBe(true);
  });

  it("is conservative about how many times", () => {
    expect(DEFAULT_DOWNLOAD_RETRY.maxRetries).toBe(3);
  });

  it("offers exactly the four documented choices", () => {
    expect(RETRY_LIMIT_CHOICES).toEqual([1, 3, 5, "unlimited"]);
  });
});

describe("whether another attempt is allowed", () => {
  // C: the cap is the cap.
  it("counts failures against the cap", () => {
    const s = settings({ maxRetries: 3 });
    expect(retryAllowed(0, s)).toBe(true); // first failure → retry 1
    expect(retryAllowed(1, s)).toBe(true);
    expect(retryAllowed(2, s)).toBe(true); // → retry 3
    expect(retryAllowed(3, s)).toBe(false); // three retries used
  });

  it("honours a cap of one", () => {
    const s = settings({ maxRetries: 1 });
    expect(retryAllowed(0, s)).toBe(true);
    expect(retryAllowed(1, s)).toBe(false);
  });

  // B: the switch is the switch, whatever the cap says.
  it("never retries when the user turned it off", () => {
    expect(retryAllowed(0, settings({ autoRetry: false }))).toBe(false);
    expect(
      retryAllowed(0, settings({ autoRetry: false, maxRetries: "unlimited" })),
    ).toBe(false);
  });

  it("keeps going when the user asked for unlimited", () => {
    const s = settings({ maxRetries: "unlimited" });
    expect(retryAllowed(0, s)).toBe(true);
    expect(retryAllowed(500, s)).toBe(true);
  });
});

// D: the backoff is a pure function of the attempt number, so it is stated
// rather than timed. A test that waited 10 real seconds to check a 10-second
// delay would be a test nobody runs.
describe("the backoff", () => {
  it("is 2s, then 5s, then 10s", () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(5_000);
    expect(retryDelayMs(3)).toBe(10_000);
  });

  it("stays bounded however many attempts have gone by", () => {
    // What keeps "unlimited" from becoming either a tight loop or a screen
    // that says "retrying in 4 minutes".
    expect(retryDelayMs(4)).toBe(10_000);
    expect(retryDelayMs(99)).toBe(10_000);
  });

  it("never waits zero", () => {
    // A tight retry loop against a failing server is worse than not retrying.
    for (let n = 1; n <= 10; n++) expect(retryDelayMs(n)).toBeGreaterThan(0);
  });
});

describe("a stored setting from another version", () => {
  it("falls back rather than producing a cap of NaN", () => {
    // NaN compares false against everything, which would silently mean "never
    // retry" — a behaviour change nobody chose.
    expect(normalizeRetrySettings({ maxRetries: "lots" }).maxRetries).toBe(3);
    expect(normalizeRetrySettings({ maxRetries: null }).maxRetries).toBe(3);
    expect(normalizeRetrySettings(null)).toEqual(DEFAULT_DOWNLOAD_RETRY);
  });

  it("keeps a value it does understand", () => {
    expect(normalizeRetrySettings({ autoRetry: false, maxRetries: 5 })).toEqual({
      autoRetry: false,
      maxRetries: 5,
    });
    expect(normalizeRetrySettings({ maxRetries: "unlimited" }).maxRetries).toBe(
      "unlimited",
    );
  });
});

describe("what the user is told", () => {
  it("names the attempt and the cap", () => {
    expect(
      describeRetry({ attempt: 2, max: 3, secondsRemaining: 0, reason: "x" }),
    ).toBe("Download interrupted. Retrying 2 of 3…");
  });

  it("counts down while it waits", () => {
    expect(
      describeRetry({ attempt: 2, max: 3, secondsRemaining: 5, reason: "x" }),
    ).toContain("in 5s");
  });

  it("claims no total when the user asked for unlimited", () => {
    const text = describeRetry({
      attempt: 7,
      max: null,
      secondsRemaining: 0,
      reason: "x",
    });
    expect(text).toBe("Download interrupted. Retrying 7…");
    expect(text).not.toContain("of");
  });
});

describe("the wait itself", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("resolves true once the full time has passed", async () => {
    const promise = waitForRetry(5_000, new AbortController().signal);
    jest.advanceTimersByTime(5_000);
    await expect(promise).resolves.toBe(true);
  });

  it("counts down once a second", async () => {
    const ticks: number[] = [];
    const promise = waitForRetry(3_000, new AbortController().signal, (n) =>
      ticks.push(n),
    );
    jest.advanceTimersByTime(3_000);
    await promise;
    // The first tick is published before any time passes, so the screen shows
    // the full wait rather than starting one second in.
    expect(ticks[0]).toBe(3);
    expect(ticks).toEqual([3, 2, 1, 0]);
  });

  // G: the reason this is not a plain sleep.
  it("resolves false the moment it is aborted", async () => {
    const controller = new AbortController();
    const promise = waitForRetry(10_000, controller.signal);
    jest.advanceTimersByTime(1_000);
    controller.abort();
    await expect(promise).resolves.toBe(false);
  });

  it("does not wait at all when cancellation already happened", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForRetry(10_000, controller.signal),
    ).resolves.toBe(false);
  });

  it("stops ticking after it is aborted", async () => {
    const controller = new AbortController();
    const ticks: number[] = [];
    const promise = waitForRetry(10_000, controller.signal, (n) => ticks.push(n));
    jest.advanceTimersByTime(2_000);
    controller.abort();
    await promise;
    const settled = ticks.length;
    jest.advanceTimersByTime(10_000);
    expect(ticks).toHaveLength(settled);
  });
});

// Persistence, and the reason it is read late rather than cached.
describe("reading and writing the setting", () => {
  const mockGet = getConfig as jest.MockedFunction<typeof getConfig>;
  const mockSet = setConfig as jest.MockedFunction<typeof setConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(null);
  });

  it("defaults when nothing has been stored", async () => {
    await expect(getDownloadRetrySettings()).resolves.toEqual(
      DEFAULT_DOWNLOAD_RETRY,
    );
  });

  it("defaults when what was stored is not JSON", async () => {
    mockGet.mockResolvedValue("{not json");
    await expect(getDownloadRetrySettings()).resolves.toEqual(
      DEFAULT_DOWNLOAD_RETRY,
    );
  });

  it("round-trips a choice", async () => {
    await setDownloadRetrySettings({ autoRetry: false, maxRetries: "unlimited" });
    const [key, body] = mockSet.mock.calls[0] ?? [];
    expect(key).toBe("download_retry");
    mockGet.mockResolvedValue(body as string);
    await expect(getDownloadRetrySettings()).resolves.toEqual({
      autoRetry: false,
      maxRetries: "unlimited",
    });
  });

  // Live, with no reload: the store calls this at the moment it decides, so a
  // change made during a backoff is obeyed by the next decision.
  it("reads the store every time rather than caching", async () => {
    await getDownloadRetrySettings();
    await getDownloadRetrySettings();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
