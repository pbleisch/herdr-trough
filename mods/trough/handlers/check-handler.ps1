# Checks the person's own handler on Windows before Trough turns it on or runs it: the Windows
# counterpart of the checks in core/open-handlers.js. Trough runs it as
#   pwsh -File check-handler.ps1 LOCATION
# and it prints "ok<TAB>REAL PATH<TAB>SHA-256", "missing" or "refused<TAB>why".
#
# The check follows LOCATION and every link on the way. The file must be a .ps1 file owned by
# this user (or Administrators, the owner Windows gives files an elevated program makes, or
# SYSTEM) that no other user may change: no other account (Everyone, Users, Authenticated
# Users, any user or group but this user, SYSTEM, Administrators and TrustedInstaller) may
# write, append to, delete, re-permission or take it. Its folder must be owned by this user,
# SYSTEM, Administrators or TrustedInstaller, and no other account may add, delete or rename
# entries in it or change it; every folder above it, and above each link, the same, except
# that others may create new folders in it (Windows lets every user do that at a drive's root).

#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

# Trough reads the answer as UTF-8. The bytes go to the stream directly, so a path with letters
# outside the console's code page (an accented user folder, say) arrives unchanged.
function Say([string]$text) {
	$bytes = [Text.UTF8Encoding]::new($false).GetBytes($text + "`n")
	$out = [Console]::OpenStandardOutput()
	$out.Write($bytes, 0, $bytes.Length)
	$out.Flush()
}

# The real path of an absolute local path: the drive letter upper case, each name as it is on
# disk, and every link (symlink or junction) on the way resolved, the last name's too when
# $followLeaf. The last name may be missing; every folder above it must exist. With $folders
# (a list), adds each folder that held a link that was followed.
function Get-RealPath([string]$path, [bool]$followLeaf, $folders = $null) {
	for ($hops = 0; $hops -le 20; $hops++) {
		$full = [IO.Path]::GetFullPath($path)
		$root = [IO.Path]::GetPathRoot($full)
		if ($root -notmatch '^[A-Za-z]:\\$') { throw "$path is not on a local drive" }
		$parts = @($full.Substring($root.Length).Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries))
		$cur = $root.ToUpperInvariant()
		$restart = $null
		$opts = [IO.EnumerationOptions]::new()
		$opts.MatchType = [IO.MatchType]::Simple
		$opts.MatchCasing = [IO.MatchCasing]::CaseInsensitive
		$opts.AttributesToSkip = [IO.FileAttributes]::None
		$opts.IgnoreInaccessible = $true
		# Win32 matching also finds a name by its 8.3 short name (C:\Users\RUNNER~1).
		$short = [IO.EnumerationOptions]::new()
		$short.MatchType = [IO.MatchType]::Win32
		$short.AttributesToSkip = [IO.FileAttributes]::None
		$short.IgnoreInaccessible = $true
		for ($i = 0; $i -lt $parts.Count; $i++) {
			$name = $parts[$i]
			$last = $i -eq $parts.Count - 1
			$entry = $null
			if ([IO.Directory]::Exists($cur)) {
				$entry = [IO.DirectoryInfo]::new($cur).EnumerateFileSystemInfos($name, $opts) | Select-Object -First 1
				if (-not $entry -and $name.Contains('~')) {
					$entry = [IO.DirectoryInfo]::new($cur).EnumerateFileSystemInfos($name, $short) | Select-Object -First 1
				}
			}
			if (-not $entry) {
				if ($last) { return [IO.Path]::Join($cur, $name) }
				throw "the folder $([IO.Path]::Join($cur, $name)) is gone"
			}
			if ($entry.LinkTarget -and (-not $last -or $followLeaf)) {
				if ($null -ne $folders) { $folders.Add($cur) }
				$t = $entry.LinkTarget -replace '^\\\\\?\\', '' -replace '^\\\?\?\\', ''
				if (-not [IO.Path]::IsPathRooted($t)) { $t = [IO.Path]::Join($cur, $t) }
				$rest = @($parts | Select-Object -Skip ($i + 1))
				$restart = if ($rest.Count) { [IO.Path]::Join($t, ($rest -join '\')) } else { $t }
				break
			}
			$cur = [IO.Path]::Join($cur, $entry.Name)
		}
		if ($null -eq $restart) { return $cur }
		$path = $restart
	}
	throw "$path is a loop of links"
}


# Rights that let another account change a file or folder, or what a path leads to.
$WRITE_DATA = 0x2; $APPEND_DATA = 0x4; $DELETE_CHILD = 0x40; $DELETE = 0x10000
$WRITE_DAC = 0x40000; $WRITE_OWNER = 0x80000; $GENERIC_ALL = 0x10000000; $GENERIC_WRITE = 0x40000000
$TAKE = $DELETE -bor $WRITE_DAC -bor $WRITE_OWNER -bor $GENERIC_ALL -bor $GENERIC_WRITE
$FILE_BAD = $TAKE -bor $WRITE_DATA -bor $APPEND_DATA
$OWN_DIR_BAD = $TAKE -bor $WRITE_DATA -bor $APPEND_DATA -bor $DELETE_CHILD
$UP_DIR_BAD = $TAKE -bor $WRITE_DATA -bor $DELETE_CHILD

$Me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# SYSTEM, Administrators, TrustedInstaller, and OWNER RIGHTS (the owner, checked to be one of these).
$Trusted = @($Me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-4')

function Name-Of([string]$sid) {
	try {
		return ([Security.Principal.SecurityIdentifier]::new($sid)).Translate([Security.Principal.NTAccount]).Value
	} catch {
		return $sid
	}
}

# Why another account can change $path (a file or folder), or $null. $bad: the rights that
# count; $owners: the SIDs that may own it.
function Test-Acl([string]$path, [int]$bad, [string[]]$owners) {
	try {
		$acl = Get-Acl -LiteralPath $path
	} catch {
		return "cannot read the permissions of $path"
	}
	$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
	if ($owner -notin $owners) { return "$path is owned by $(Name-Of $owner)" }
	foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
		if ($r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
		if ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
		if ($r.IdentityReference.Value -in $Trusted) { continue }
		if ([int]$r.FileSystemRights -band $bad) { return "$path can be changed by $(Name-Of $r.IdentityReference.Value)" }
	}
	return $null
}

# Why a folder chain from $dir up to its drive's root is not safe, or $null.
function Test-Folders([string]$dir, [bool]$own) {
	$owners = @($Me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
	$q = $dir
	$first = $own
	while ($q) {
		$why = Test-Acl $q $(if ($first) { $OWN_DIR_BAD } else { $UP_DIR_BAD }) $owners
		if ($why) { return $why }
		$first = $false
		$q = [IO.Path]::GetDirectoryName($q)
	}
	return $null
}

# Checks the handler at $loc: { real, sha } or { missing } or { why }.
function Test-Handler([string]$loc) {
	if (-not (Test-Path -LiteralPath $loc)) {
		$i = Get-Item -LiteralPath $loc -Force -ErrorAction SilentlyContinue
		if (-not $i) { return @{ missing = $true; why = "there is no handler at $loc" } }
	}
	$links = [Collections.Generic.List[string]]::new()
	try {
		$real = Get-RealPath $loc $true $links
	} catch {
		return @{ why = $_.Exception.Message }
	}
	if (-not [IO.File]::Exists($real)) {
		if ([IO.Directory]::Exists($real)) { return @{ why = "$real is not a regular file" } }
		return @{ why = "$loc leads to $real, which does not exist" }
	}
	if ($real -notmatch '\.ps1$') { return @{ why = "$real is not a PowerShell script (.ps1)" } }
	$why = Test-Acl $real $FILE_BAD @($Me, 'S-1-5-18', 'S-1-5-32-544')
	if ($why) { return @{ why = "$real is not yours alone ($why)" } }
	$why = Test-Folders ([IO.Path]::GetDirectoryName($real)) $true
	if ($why) { return @{ why = $why } }
	foreach ($d in $links) {
		$why = Test-Folders $d $false
		if ($why) { return @{ why = $why } }
	}
	try {
		$sha = (Get-FileHash -LiteralPath $real -Algorithm SHA256).Hash.ToLowerInvariant()
	} catch {
		return @{ why = "cannot hash $real" }
	}
	return @{ real = $real; sha = $sha }
}

$a = [string[]]@($args | ForEach-Object { [string]$_ })
if ($a.Count -ne 1) { exit 2 }
$c = Test-Handler $a[0]
if ($c.ContainsKey('real')) { Say "ok`t$($c.real)`t$($c.sha)" }
elseif ($c.ContainsKey('missing')) { Say 'missing' }
else { Say "refused`t$($c.why)" }
exit 0
