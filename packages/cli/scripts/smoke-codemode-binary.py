#!/usr/bin/env python3
"""Offline native-binary check (macOS/Linux): python3 smoke-codemode-binary.py /path/to/pizza"""
import json
import os
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# A synthetic provider requests real codemode execution, then checks its result.
# No provider credentials, network model requests, or existing user config are used.
PROVIDER = r'''
export default function (pi) {
  pi.registerProvider("pizzapi-smoke", {
    name: "Offline smoke", baseUrl: "http://127.0.0.1:1", apiKey: "synthetic", api: "openai-responses",
    models: [{ id: "smoke-model", name: "smoke-model", api: "openai-responses", reasoning: false,
      input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:8192,maxTokens:1024 }],
    streamSimple(_model, context) {
      const result = context.messages.findLast(m => m.role === "toolResult");
      const output = result ? (JSON.stringify(result.content).includes("42") && !result.isError
        ? "SMOKE_OK_CODEMODE_42" : "SMOKE_FAILED_" + JSON.stringify(result)) : undefined;
      const message = {
        role:"assistant",api:"openai-responses",provider:"pizzapi-smoke",model:"smoke-model",timestamp:Date.now(),
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        content:result ? [{type:"text",text:output}]
          : [{type:"toolCall",id:"smoke-call",name:"codemode",arguments:{code:"return 6 * 7;"}}],
        stopReason:result ? "stop":"toolUse"
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield {type:"start",partial:message};
          if (result) {
            yield {type:"text_start",contentIndex:0,partial:message};
            yield {type:"text_delta",contentIndex:0,delta:output,partial:message};
            yield {type:"text_end",contentIndex:0,content:output,partial:message};
          }
          yield {type:"done",reason:message.stopReason,message};
        },
        result: async () => message
      };
    }
  });
}
'''


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: smoke-codemode-binary.py /absolute/path/to/pizza")
    binary = str(Path(sys.argv[1]).resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="pizzapi-codemode-smoke-") as temp:
        home = Path(temp)
        agent = home / ".pizzapi"
        (agent / "extensions").mkdir(parents=True)
        (agent / "extensions" / "smoke.js").write_text(PROVIDER)
        (agent / "settings.json").write_text(json.dumps({
            "defaultProvider": "pizzapi-smoke", "defaultModel": "smoke-model",
            "defaultTools": ["codemode"], "extensions": ["extensions/smoke.js"],
            "quietStartup": False, "tuiMode": "regular", "theme": "dark",
            "retry": {"enabled": False}, "cacheWarming": "off", "enableInstallTelemetry": False,
        }))
        (agent / "auth.json").write_text(json.dumps({"pizzapi-smoke": {"type": "api_key", "key": "synthetic"}}))
        master, slave = pty.openpty()
        process = subprocess.Popen(
            [binary, "--no-relay", "--no-mcp", "--no-plugins", "--no-hooks", "--sandbox", "off"],
            cwd=temp,
            env={"HOME": temp, "PATH": os.environ["PATH"], "TERM": "xterm-256color",
                 "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1"},
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        output = bytearray()
        sent = False
        passed = False
        deadline = time.monotonic() + 45
        try:
            while time.monotonic() < deadline and process.poll() is None:
                ready, _, _ = select.select([master], [], [], max(0, min(1, deadline - time.monotonic())))
                if not ready:
                    continue
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
                # The model footer appears before submit is enabled. The resource
                # listing is rendered after that boundary; do not submit earlier.
                if not sent and b"smoke.js" in output:
                    os.write(master, b"Compute six times seven.\r")
                    sent = True
                if b"SMOKE_OK_CODEMODE_42" in output:
                    passed = True
                    break
                if b"SMOKE_FAILED_" in output:
                    break
        finally:
            # This checks worker/WASM execution, not interactive shutdown. A PTY
            # can still be streaming when the assertion succeeds; bound cleanup.
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            os.close(master)
        if not passed:
            print(output.decode(errors="replace"), file=sys.stderr)
            raise SystemExit("FAIL: compiled codemode did not return 42")
        print("PASS: compiled codemode worker + embedded QuickJS returned 42")


if __name__ == "__main__":
    main()
