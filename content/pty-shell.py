"""Make the already allocated slave PTY the controlling terminal before exec."""
import fcntl
import os
import sys
import termios

fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.execvp(sys.argv[1], sys.argv[1:])
