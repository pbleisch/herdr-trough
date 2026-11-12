# Trough's built-in open and reveal actions on Windows: the default app, Explorer and the
# default browser. It ships with the mod and is replaced when the mod is reinstalled; to change
# what an action does, write your own handler instead (README, "Your own handler"). Trough runs
# it as
#   pwsh -File windows.ps1 VERB -- ITEM
# and reads the exit status: 0 done, 10 not handled, anything else failed (stderr says why).
#   open -- PATH        open with its default app (the shell's association)
#   reveal -- PATH      show selected in Explorer (explorer /select,)
#   open-url -- URL     open an http or https link in the default browser
# With TROUGH_DRY_RUN=1 it prints what it would run (one line, `would: ...`) and runs nothing.

#Requires -Version 7.0
Set-StrictMode -Version 3.0

$dry = $env:TROUGH_DRY_RUN -eq '1'

function Fail([string]$why, [int]$code = 1) {
	[Console]::Error.WriteLine($why)
	exit $code
}

# Types Windows would run or install rather than show: Trough reveals these instead of opening
# them; this refuses them too.
$Runs = @('exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle',
	'appinstaller', 'application', 'appref-ms', 'lnk', 'url', 'website', 'pif', 'scr', 'cpl', 'msc', 'inf', 'reg', 'vbs', 'vbe', 'js', 'jse',
	'wsf', 'wsh', 'wsc', 'ws', 'hta', 'chm', 'jar', 'gadget', 'scf', 'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms',
	'diagcab', 'msh', 'msh1', 'msh2', 'mshxml', 'iso', 'img', 'vhd', 'vhdx', 'xll', 'py', 'pyw', 'pl', 'rb', 'sh')

function Test-Runs([string]$path) {
	$e = [IO.Path]::GetExtension($path).TrimStart('.').ToLowerInvariant()
	if (-not $e) { return $false }
	if ($e -in $Runs) { return $true }
	$pathext = @(($env:PATHEXT ?? '') -split ';' | ForEach-Object { $_.Trim().TrimStart('.').ToLowerInvariant() })
	return $e -in $pathext
}

$a = [string[]]@($args | ForEach-Object { [string]$_ })
if ($a.Count -ne 3 -or $a[1] -cne '--') { exit 2 }
$verb = $a[0]
$item = $a[2]

function Local-Path {
	if ($item -notmatch '^[A-Za-z]:\\' -or $item.Contains('"')) { Fail "not a local path: $item" 2 }
	return $item
}

switch -CaseSensitive ($verb) {
	'open' {
		$p = Local-Path
		if (Test-Runs $p) { Fail "$([IO.Path]::GetFileName($p)) could run, so it is not opened" }
		if ($dry) {
			[Console]::Out.WriteLine("would: open $p")
			exit 0
		}
		try {
			$si = [Diagnostics.ProcessStartInfo]::new($p)
			$si.UseShellExecute = $true
			[void][Diagnostics.Process]::Start($si)
		} catch {
			Fail "Windows could not open it: $($_.Exception.Message)"
		}
		exit 0
	}
	'reveal' {
		$p = Local-Path
		# explorer.exe parses its own command line: the path is quoted (it cannot contain a quote).
		$explorer = Join-Path $env:SystemRoot 'explorer.exe'
		$line = "/select,`"$p`""
		if ($dry) {
			[Console]::Out.WriteLine("would: $explorer $line")
			exit 0
		}
		$si = [Diagnostics.ProcessStartInfo]::new($explorer, $line)
		$si.UseShellExecute = $false
		try {
			[void][Diagnostics.Process]::Start($si)
		} catch {
			Fail "Explorer did not start: $($_.Exception.Message)"
		}
		exit 0
	}
	'open-url' {
		$u = $null
		if (-not [Uri]::TryCreate($item, [UriKind]::Absolute, [ref]$u) -or $u.Scheme -notin @('http', 'https')) { Fail 'only http and https links are opened' 2 }
		if ($dry) {
			[Console]::Out.WriteLine("would: open-url $($u.AbsoluteUri)")
			exit 0
		}
		try {
			$si = [Diagnostics.ProcessStartInfo]::new($u.AbsoluteUri)
			$si.UseShellExecute = $true
			[void][Diagnostics.Process]::Start($si)
		} catch {
			Fail "Windows could not open the link: $($_.Exception.Message)"
		}
		exit 0
	}
	default { exit 10 }
}
