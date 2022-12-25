#!/usr/bin/env python3
#
# Obsidian Terminal Plugin PTY helper
#
# node-pty uses a "non-context aware" native module, which is not supported by
# recent Electron versions, so I made this small helper that uses fd 3 to
# communicate terminal size changes
#
# Note that in order to test this from a regular shell, you probably want to
# redirect fd 3 from /dev/null, i.e. ./pty-helper.py 3</dev/null
#
# This script is only intended to be used as a helper-script from Obsidian in
# order to allocate a PTY for use with xterm.js
#
# Joel Eriksson <je@clevcode.org> 2022

import termios
import select
import fcntl
import errno
import pty
import sys
import pwd
import os

# Determine the path to the users shell, if not specified
if len(sys.argv) < 2:
    if os.getenv('SHELL'):
        path = os.getenv('SHELL')
    else:
        path = pwd.getpwuid(os.getuid())[6]
else:
    path = sys.argv[1]

# Determine the arguments, if not provided (including argv[0])
if len(sys.argv) < 3:
    argv = [path]
else:
    argv = sys.argv[1:]

def pty_fork(path, argv=None, envp=None):
    if not argv:
        argv = [os.path.basename(path)]
    if not envp:
        envp = os.environ
    pid, fd = pty.fork()
    if pid == 0:
        # Anything printed here will show up in the pty
        os.execve(path, argv, envp)
    return fd, pid

fd, pid = pty_fork(path, argv)

fds = [fd, 0, 3]

proc = os.fdopen(fd, 'wb', 32768)

while True:
    rfds, _, _ = select.select(fds, [], [])
    if fd in rfds:
        try:
            buf = os.read(fd, 32768)
            sys.stdout.buffer.write(buf)
            sys.stdout.buffer.flush()
        except OSError as e:
            if e.errno in (errno.EINTR, errno.EAGAIN):
                continue
            if e.errno == errno.EIO:
                break
            sys.stderr.write(f'read(pty): {str(e)}')
            break
    if 0 in rfds:
        try:
            buf = os.read(0, 32768)
            proc.write(buf)
            proc.flush()
        except OSError as e:
            if e.errno in (errno.EINTR, errno.EAGAIN):
                continue
            sys.stderr.write(f'read(stdin): {str(e)}')
            break
    if 3 in rfds:
        try:
            winsize = os.read(3, 8)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
        except OSError as e:
            if e.errno in (errno.EINTR, errno.EAGAIN):
                continue
            sys.stderr.write(f'read(winsize): {str(e)}')
            break
