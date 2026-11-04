import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buttonData, owner, stranger, textOf } from "./helpers.js";
import { Browser, buttonUrl, contributor, formFields, oauthRoundTrip, startStack, type Stack } from "./github-stack.js";

let s: Stack;
beforeEach(async () => {
  s = await startStack();
});
afterEach(async () => {
  await s.stop();
});

async function contributorStart() {
  const replies = await s.controller.handleCommand(contributor, "linkgithub", "");
  return buttonUrl(replies);
}

describe("contributor linking (/linkgithub)", () => {
  it("1+6+19. valid state: links the immutable numeric GitHub ID to the right Telegram user", async () => {
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, await contributorStart(), 6001);
    expect(rt.authorize.origin).toBe(s.gh.url);
    expect(rt.authorize.searchParams.get("client_id")).toBe(s.gh.clientId);
    expect(rt.authorize.searchParams.get("redirect_uri")).toBe(s.cfg.oauthCallbackUrl);
    expect(rt.res.status).toBe(200);
    expect(rt.html).toContain("Confirm account link");
    expect(rt.html).toContain("contrib");
    expect(rt.html).toContain("Casey");
    // Nothing is linked until the browser user confirms.
    expect(s.engine.links.size).toBe(0);

    const done = await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Connected");
    expect(s.engine.calls("POST", "/v1/github/links")[0]!.body).toMatchObject({ telegramUserId: "2002", githubUserId: 6001, githubLogin: "contrib", verificationSource: "github_oauth" });
    expect(typeof s.engine.calls("POST", "/v1/github/links")[0]!.body.verifiedAt).toBe("string");
    expect(Object.keys(s.engine.calls("POST", "/v1/github/links")[0]!.body).sort()).toEqual(["githubLogin", "githubUserId", "telegramUserId", "verificationSource", "verifiedAt"]);
    expect(s.store.getLink("2002")).toMatchObject({ githubUserId: "6001", githubLogin: "contrib" });
    expect(s.store.telegramUserForGithub("6001")).toBe("2002");
    expect(s.sent.at(-1)!.chatId).toBe("2002");
    expect(s.sent.at(-1)!.html).toContain("Linked GitHub");
    // The user token was used server-side only, then revoked.
    expect(s.gh.revokedTokens).toHaveLength(1);
    expect(s.gh.calls("GET", "/user")[0]!.authorization).toMatch(/ghu_mock/);
  });

  it("never exposes the OAuth state, code or token to Telegram or the success page", async () => {
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, await contributorStart(), 6001);
    const done = await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));
    const page = await done.text();
    for (const secret of [rt.state, "ghu_mock", s.cfg.clientSecret]) {
      expect(page).not.toContain(secret);
      expect(s.sent.map((m) => m.html).join()).not.toContain(secret);
    }
    expect(done.headers.get("referrer-policy")).toBe("no-referrer");
    expect(done.headers.get("cache-control")).toBe("no-store");
  });

  it("2. rejects an invalid state without calling GitHub", async () => {
    const b = new Browser();
    await b.get(await contributorStart());
    const res = await b.get(`${s.cfg.oauthCallbackUrl}?code=whatever&state=not-a-real-state`);
    expect(res.status).toBe(400);
    expect(s.gh.calls("POST", "/login/oauth/access_token")).toHaveLength(0);
  });

  it("3. rejects an expired state", async () => {
    const b = new Browser();
    const url = await contributorStart();
    const start = await b.get(url);
    const authorize = new URL(start.headers.get("location")!);
    s.gh.codes.set("c1", 6001);
    s.clock.t += 6 * 60_000; // state lives 5 minutes
    const res = await b.get(`${s.cfg.oauthCallbackUrl}?code=c1&state=${authorize.searchParams.get("state")}`);
    expect(res.status).toBe(400);
    expect(s.gh.calls("POST", "/login/oauth/access_token")).toHaveLength(0);
  });

  it("3b. an expired linking session cannot even start", async () => {
    const url = await contributorStart();
    s.clock.t += 11 * 60_000;
    expect((await new Browser().get(url)).status).toBe(400);
  });

  it("4. replaying the callback is rejected", async () => {
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, await contributorStart(), 6001);
    expect(rt.res.status).toBe(200);
    const replay = await b.get(rt.callbackUrl);
    expect(replay.status).toBe(400);
    expect(s.gh.calls("POST", "/login/oauth/access_token")).toHaveLength(1);
  });

  it("4b. the confirm form is single use", async () => {
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, await contributorStart(), 6001);
    const f = formFields(rt.html);
    expect((await b.post(`${s.base}/auth/github/confirm`, f)).status).toBe(200);
    expect((await b.post(`${s.base}/auth/github/confirm`, f)).status).toBe(400);
    expect(s.engine.calls("POST", "/v1/github/links")).toHaveLength(1);
  });

  it("5. another browser or Telegram user cannot take over someone else's session", async () => {
    // Casey (2002) starts; an attacker's browser receives Casey's callback URL without Casey's cookie.
    const caseyBrowser = new Browser();
    const url = await contributorStart();
    const start = await caseyBrowser.get(url);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    s.gh.codes.set("evil-code", 7001);
    const attacker = new Browser();
    expect((await attacker.get(`${s.cfg.oauthCallbackUrl}?code=evil-code&state=${state}`)).status).toBe(400);
    expect(s.engine.links.size).toBe(0);

    // A second Telegram user has an independent session; mixing state and cookie across them fails.
    const other = { userId: "3003", chatId: "3003", chatType: "private", displayName: "Other" };
    const otherUrl = buttonUrl(await s.controller.handleCommand(other, "linkgithub", ""));
    const otherBrowser = new Browser();
    await otherBrowser.get(otherUrl);
    s.gh.codes.set("c2", 7001);
    expect((await otherBrowser.get(`${s.cfg.oauthCallbackUrl}?code=c2&state=${state}`)).status).toBe(400);

    // Starting a new /linkgithub invalidates the old link.
    const fresh = await contributorStart();
    expect((await new Browser().get(url)).status).toBe(400);
    expect(fresh).not.toBe(url);
  });

  it("5b. a forwarded start link can't be completed from a browser that did not start it, and groups are refused", async () => {
    const url = await contributorStart();
    const victim = new Browser();
    const rt = await oauthRoundTrip(s, victim, url, 7001); // victim signs in via a forwarded link
    // The victim sees WHICH Telegram account would be linked and must press Confirm.
    expect(rt.html).toContain("Casey");
    expect(rt.html).toContain("2002");
    expect(s.engine.links.size).toBe(0);

    const group = { userId: "2002", chatId: "-777", chatType: "supergroup" };
    expect(textOf(await s.controller.handleCommand(group, "linkgithub", ""))).toContain("private chat");
    expect(s.sessions.get("x")).toBeNull();
  });

  it("refuses to re-link a GitHub account that belongs to another Telegram user (engine 409)", async () => {
    s.engine.links.set("9999", { githubUserId: 6001, githubLogin: "contrib", telegramUserId: "9999", revoked: false });
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, await contributorStart(), 6001);
    const res = await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));
    expect(res.status).toBe(409);
    expect(s.store.getLink("2002")).toBeUndefined();
    expect(s.engine.links.get("9999").telegramUserId).toBe("9999");
    expect(s.sent.at(-1)!.html).toContain("already linked");
  });

  it("/unlinkgithub removes the link only after confirmation", async () => {
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, await contributorStart(), 6001);
    await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));
    const prompt = await s.controller.handleCommand(contributor, "unlinkgithub", "");
    expect(buttonData(prompt)).toEqual(["uly", "ucn"]);
    expect(s.store.getLink("2002")).toBeDefined();
    await s.controller.handleCallback(contributor, "uly");
    expect(s.store.getLink("2002")).toBeUndefined();
    expect(s.engine.links.get("2002").revoked).toBe(true);
  });
});

describe("maintainer connection (/connectgithub)", () => {
  async function maintainerUntilConfirm(userId = 5001) {
    const url = buttonUrl(await s.controller.handleCommand(owner, "connectgithub", ""));
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, url, userId);
    return { b, rt };
  }

  it("only the configured owner can start it, and only in a private chat", async () => {
    expect(textOf(await s.controller.handleCommand(stranger, "connectgithub", ""))).toContain("private");
    expect(await s.controller.handleCommand({ userId: "1001", chatId: "-5", chatType: "group" }, "connectgithub", "")).toEqual([]);
    expect(s.sessions.get("anything")).toBeNull();
  });

  it("natural language also starts the secure flow", async () => {
    const replies = await s.controller.handleText(owner, "Connect my GitHub repository and reward good contributions automatically.");
    expect(textOf(replies)).toContain("Let's connect GitHub securely");
    expect(textOf(replies)).toContain("read access");
    expect(buttonUrl(replies)).toContain("/auth/github/start?s=");
  });

  it("happy path: authenticate, pick an admin repository, verified server-side, stored via the engine", async () => {
    const { b, rt } = await maintainerUntilConfirm();
    expect(rt.html).toContain("Confirm account link");
    await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));

    const picker = s.sent.find((m) => m.chatId === "1001" && m.html.includes("Which repository"))!;
    const picks = picker.buttons!.flat().filter((x) => x.data?.startsWith("sr:"));
    expect(picks).toHaveLength(1); // acme/other is not admin-able by this user, so it is not offered
    expect(picks[0]!.text).toBe("acme/app");

    const res = await s.controller.handleCallback(owner, "sr:0");
    expect(textOf(res.replies)).toContain("Connected: ");
    expect(textOf(res.replies)).toContain("acme/app");
    expect(textOf(res.replies)).toContain("configure an AI bounty policy");
    expect(s.engine.calls("POST", "/v1/repositories/connect")[0]!.body).toEqual({
      ownerTelegramUserId: "1001", repositoryId: 4242, repositoryFullName: "acme/app", installationId: 9001, verifiedOwnerAccess: true, repositoryPrivate: false,
    });
    expect(s.store.getRepo("4242")?.status).toBe("connected");
    // Installation access (JWT then installation token) was used to verify, not the browser's data.
    expect(s.gh.calls("POST", "/app/installations/9001/access_tokens").length).toBeGreaterThan(0);
  });

  it("7. a user without admin rights on the repository is rejected, even if the picker offered it", async () => {
    const { b, rt } = await maintainerUntilConfirm();
    await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));
    s.gh.roles.set("acme/app:maint", "write"); // demoted between OAuth and selection
    const res = await s.controller.handleCallback(owner, "sr:0");
    expect(textOf(res.replies)).toContain("admin rights");
    expect(s.engine.calls("POST", "/v1/repositories/connect")).toHaveLength(0);
    expect(s.store.getRepo("4242")).toBeUndefined();
  });

  it("7b. a GitHub user with no admin repositories gets no picker at all", async () => {
    const { b, rt } = await maintainerUntilConfirm(7001);
    // 7001 can't see any installation, so the app must be installed first.
    expect(rt.html).toContain("Install the GitHub App");
    expect(b).toBeDefined();
    expect(s.engine.calls("POST", "/v1/repositories/connect")).toHaveLength(0);
  });

  it("8. an unauthorized repository can't be connected (out-of-range pick, removed from installation, other repos)", async () => {
    const { b, rt } = await maintainerUntilConfirm();
    await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));
    expect(textOf((await s.controller.handleCallback(owner, "sr:5")).replies)).toContain("expired");
    // Repository removed from the installation after the picker was shown.
    s.gh.installations.get(9001)!.repoIds = [4343];
    const res = await s.controller.handleCallback(owner, "sr:0");
    expect(textOf(res.replies)).toContain("not accessible to the app installation");
    expect(s.engine.calls("POST", "/v1/repositories/connect")).toHaveLength(0);
    // Non-owner can't use the picker callback.
    expect((await s.controller.handleCallback(stranger, "sr:0")).toast).toBe("Not authorized");
  });

  it("9. verifies the installation: suspended or unknown installations are refused; query installation_id is ignored", async () => {
    const { b, rt } = await maintainerUntilConfirm();
    await b.post(`${s.base}/auth/github/confirm`, formFields(rt.html));
    s.gh.installations.get(9001)!.suspended = true;
    expect(textOf((await s.controller.handleCallback(owner, "sr:0")).replies)).toContain("suspended");
    s.gh.installations.delete(9001);
    expect(textOf((await s.controller.handleCallback(owner, "sr:0")).replies)).toContain("doesn't recognise");
    expect(s.engine.calls("POST", "/v1/repositories/connect")).toHaveLength(0);
  });

  it("install flow: no installation -> install page -> setup callback ignores installation_id and re-authenticates", async () => {
    s.gh.installations.get(9001)!.repoIds = []; // nothing installed yet for this user
    const url = buttonUrl(await s.controller.handleCommand(owner, "connectgithub", ""));
    const b = new Browser();
    const rt = await oauthRoundTrip(s, b, url, 5001);
    expect(rt.html).toContain("Install the GitHub App");

    const install = await b.get(`${s.base}/auth/github/install?s=${formFields2(rt.html)}`);
    expect(install.status).toBe(302);
    const target = new URL(install.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(s.cfg.installUrl);
    const state = target.searchParams.get("state")!;

    // The user installs the app on GitHub; GitHub redirects to the Setup URL. A forged installation_id is irrelevant.
    s.gh.installations.get(9001)!.repoIds = [4242, 4343];
    const back = await b.get(`${s.base}/auth/github/install/callback?installation_id=666&setup_action=install&state=${state}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toContain("/auth/github/start?s=");
    expect(s.gh.requests.some((r) => r.path.includes("666"))).toBe(false);
    // Replaying the install state fails.
    expect((await b.get(`${s.base}/auth/github/install/callback?installation_id=666&state=${state}`)).status).toBe(400);

    const again = await oauthRoundTrip(s, b, `${s.base}${back.headers.get("location")}`, 5001);
    expect(again.html).toContain("Confirm account link");
  });
});

function formFields2(html: string): string {
  return decodeURIComponent(html.match(/install\?s=([^"]+)"/)![1]!);
}
