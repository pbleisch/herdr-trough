#!/bin/sh
# Trough's built-in open and reveal actions on Linux: xdg-open, and the file manager over D-Bus.
# It ships with the mod and is replaced when the mod is reinstalled; to change what an action
# does, write your own handler instead (README, "Your own handler"). Trough runs it as
#   sh linux.sh VERB -- ITEM
# and reads the exit status: 0 done, 10 not handled, anything else failed (stderr says why).
#   open -- PATH        xdg-open
#   reveal -- PATH      the freedesktop FileManager1 ShowItems call, else xdg-open on its folder
#   open-url -- URL     xdg-open on an http or https link
# xdg-open and gdbus are optional: when xdg-open is missing it exits 127 and says what to install.

set -u

# A file:// URI for an absolute path, every byte that is not unreserved percent-encoded (the
# slashes kept), so it also goes inside a D-Bus string literal ('...') as it is.
uri() {
	printf %s "$1" | LC_ALL=C od -An -v -tx1 2>/dev/null | LC_ALL=C awk '
		BEGIN { printf "file://"; for (i = 0; i < 16; i++) h[substr("0123456789abcdef", i + 1, 1)] = i }
		{
			for (i = 1; i <= NF; i++) {
				b = h[substr($i, 1, 1)] * 16 + h[substr($i, 2, 1)]
				if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 45 || b == 46 || b == 95 || b == 126 || b == 47) printf "%c", b
				else printf "%%%s", toupper($i)
			}
		}'
}

# Runs xdg-open "$1" in the background and waits up to 3 s for it: a desktop's opener may stay
# running as long as the app it started, which would outlive Trough's time limit. Exits with
# xdg-open's status (and its message) when it finished within that time, else 0. stderr goes
# through a file so the caller does not wait on a pipe the opener keeps open. $2 is the message
# for a missing xdg-open.
xdg() {
	command -v xdg-open >/dev/null 2>&1 || {
		echo "$2" >&2
		exit 127
	}
	e=$(mktemp) || exit 1
	xdg-open "$1" >/dev/null 2>"$e" </dev/null &
	p=$!
	n=0
	while kill -0 "$p" 2>/dev/null && [ $n -lt 30 ]; do
		sleep 0.1
		n=$((n + 1))
	done
	if kill -0 "$p" 2>/dev/null; then
		rm -f "$e"
		exit 0
	fi
	wait "$p"
	s=$?
	if [ -s "$e" ]; then cat "$e" >&2; elif [ $s = 3 ]; then echo "xdg-open found no program to open it with" >&2; fi
	rm -f "$e"
	# 10 means "not handled" to Trough; xdg-open's own statuses are 1 to 4.
	[ $s = 10 ] && s=1
	exit $s
}

[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
case ${1-} in
open)
	xdg "$3" "xdg-open is not installed (it comes with xdg-utils)"
	;;
reveal)
	if command -v gdbus >/dev/null 2>&1 && gdbus call --session --timeout 5 --dest org.freedesktop.FileManager1 \
		--object-path /org/freedesktop/FileManager1 --method org.freedesktop.FileManager1.ShowItems "['$(uri "$3")']" "''" >/dev/null 2>&1; then
		exit 0
	fi
	xdg "$(dirname -- "$3")" "no file manager answered, and xdg-open is not installed (it comes with xdg-utils)"
	;;
open-url)
	case $3 in http://* | https://*) xdg "$3" "xdg-open is not installed (it comes with xdg-utils)" ;; esac
	echo "only http and https links are opened" >&2
	exit 2
	;;
*) exit 10 ;;
esac
