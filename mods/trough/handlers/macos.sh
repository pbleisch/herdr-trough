#!/bin/sh
# Trough's built-in open and reveal actions on macOS. It ships with the mod and is replaced when
# the mod is reinstalled; to change what an action does, write your own handler instead (README,
# "Your own handler"). Trough runs it as
#   sh macos.sh VERB -- ITEM
# and reads the exit status: 0 done, 10 not handled, anything else failed (stderr says why).
#   open -- PATH        open in its default app
#   reveal -- PATH      show selected in Finder
#   open-url -- URL     open an http or https link in the default browser

set -u
[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
case ${1-} in
open) exec /usr/bin/open "$3" ;;
reveal) exec /usr/bin/open -R "$3" ;;
open-url)
	case $3 in http://* | https://*) exec /usr/bin/open "$3" ;; esac
	echo "only http and https links are opened" >&2
	exit 2
	;;
*) exit 10 ;;
esac
