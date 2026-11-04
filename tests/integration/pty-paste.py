import os, pty, sys, time, select
root, token, mode = sys.argv[1], sys.argv[2], sys.argv[3]  # test helper: simulates a terminal paste into the hidden prompt
env = dict(os.environ, BUYONCUE_SETUP_ROOT=root)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", "scripts/env-setup.mjs", "set", "chat", "TELEGRAM_BOT_TOKEN"], env)
time.sleep(1.0)
payload = {"bracketed": "\x1b[200~" + token + "\x1b[201~\r", "plain": token + "\r", "trailing-space": token + "  \r"}[mode]
os.write(fd, payload.encode())
out = b""
end = time.time() + 5
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.3)
    if r:
        try: out += os.read(fd, 4096)
        except OSError: break
print(out.decode(errors="replace").replace(token, "<TOKEN>"))
