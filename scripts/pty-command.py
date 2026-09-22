"""Test-only PTY runner: argv JSON on stdin, bounded capture, no shell."""
import errno
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

request = json.load(sys.stdin)
master, slave = pty.openpty()
process = None
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, request["columns"], 0, 0))
    # Capture application bytes without the terminal driver's LF -> CRLF mapping.
    attributes = termios.tcgetattr(slave)
    attributes[1] &= ~termios.OPOST
    termios.tcsetattr(slave, termios.TCSANOW, attributes)
    process = subprocess.Popen(request["argv"], stdin=subprocess.PIPE, stdout=slave, stderr=slave)
    os.close(slave)
    slave = None
    chunks = []
    size = 0
    deadline = time.monotonic() + 10
    # Keep the child's stdin open: a display command must exit without input/EOF.
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError("Display command did not exit without stdin input")
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            size += len(chunk)
            if size > 2 * 1024 * 1024:
                raise RuntimeError("Unexpected display output size")
            chunks.append(chunk)
    code = process.wait(timeout=1)
    if code != 0:
        raise RuntimeError("Display command failed in PTY")
    sys.stdout.buffer.write(b"".join(chunks).replace(b"\r\n", b"\n"))
finally:
    if process is not None:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdin.close()
    os.close(master)
    if slave is not None:
        os.close(slave)
