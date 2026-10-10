/**
 * Running the apply command for real.
 *
 * Kept apart from src/host/apply.ts so the route — where every decision
 * about whether a process may start lives — can be imported and tested
 * without a child process anywhere in sight. The only thing this file knows
 * is how to start one, wait for it, stop it, and hand back what it said.
 *
 * The child gets no shell. Arguments are passed as an array, so a package
 * name or a patch id containing a space or a semicolon is one argument and
 * never a fragment of a command line.
 */

import { spawn } from 'node:child_process'
import { MAX_OUTPUT_CHARS, capOutput, type RunOutcome, type RunPort } from './apply.ts'

export const nodeRunPort: RunPort = {
  run(script, args, options) {
    return new Promise<RunOutcome>((resolve) => {
      const child = spawn(script, [...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A new process group so a timeout can take the whole tree down:
        // pnpm spawns its own children, and killing only the parent would
        // leave one of them holding the profile lock.
        detached: true,
      })
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false
      let settled = false

      const collect = (which: 'out' | 'err') => (chunk: unknown) => {
        if (which === 'out') stdout += String(chunk)
        else stderr += String(chunk)
        // Cap while reading rather than after: a chatty pnpm must not be able
        // to grow this host's memory without bound just because a page is
        // waiting on it.
        if (stdout.length + stderr.length > MAX_OUTPUT_CHARS * 2) truncated = true
      }
      child.stdout?.on('data', collect('out'))
      child.stderr?.on('data', collect('err'))

      const finish = (outcome: RunOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const out = capOutput(outcome.stdout)
        const err = capOutput(outcome.stderr)
        resolve({
          ...outcome,
          stdout: out.text,
          stderr: err.text,
          truncated: truncated || out.truncated || err.truncated,
        })
      }

      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
          else child.kill('SIGTERM')
        } catch {
          // Already gone, or never started. The close handler still runs.
        }
        // SIGTERM is a request, not a guarantee. A child that ignores it must
        // not hold this request open forever.
        setTimeout(() => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch {
            // Nothing left to kill.
          }
          finish({ code: -1, stdout, stderr, timedOut: true, truncated })
        }, 5000).unref?.()
      }, options.timeoutMs)
      timer.unref?.()

      child.on('error', (error) =>
        finish({ code: -1, stdout, stderr: stderr + String(error), timedOut, truncated }),
      )
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut, truncated }))
    })
  },
}