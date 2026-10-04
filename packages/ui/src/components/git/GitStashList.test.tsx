import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GitStashList } from "./GitStashList";

// Happy DOM's selector error constructor is not installed by the minimal preload.
Object.assign(window, { SyntaxError });

const makeGit = () => ({
    available: true,
    connected: true,
    refreshKey: 1,
    operationInProgress: null as string | null,
    lastOperationResult: null,
    stashes: [],
    stashList: mock(() => {}),
    stashPush: mock(() => {}),
    stashPop: mock(() => {}),
    stashApply: mock(() => {}),
    stashDrop: mock(() => {}),
});

afterEach(cleanup);

test("refreshes stashes from the shared panel service on repository updates", () => {
    const git = makeGit();
    const { rerender } = render(<GitStashList git={git} />);
    expect(git.stashList).toHaveBeenCalledTimes(1);
    rerender(<GitStashList git={{ ...git, refreshKey: 2 }} />);
    expect(git.stashList).toHaveBeenCalledTimes(2);
    rerender(<GitStashList git={{ ...git, refreshKey: 2 }} />);
    expect(git.stashList).toHaveBeenCalledTimes(2);
});

test("does not request stashes or enable mutations while disconnected", () => {
    const git = { ...makeGit(), connected: false };
    const { getByText, rerender } = render(<GitStashList git={git} />);
    expect(git.stashList).not.toHaveBeenCalled();
    expect((getByText("Stash changes").closest("button") as HTMLButtonElement).disabled).toBe(true);
    rerender(<GitStashList git={{ ...git, connected: true }} />);
    expect(git.stashList).toHaveBeenCalledTimes(1);
});
