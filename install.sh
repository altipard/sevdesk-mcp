#!/bin/sh
# sevdesk-mcp installer: downloads the release binary for this machine, checks it against the
# release's SHA256SUMS and installs it. With a terminal it then starts the guided setup of the
# installed binary (`sevdesk-mcp setup`): agents, scope, mode, token into the system keychain.
#
#   curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
#
# Environment:
#   INSTALL_DIR          target directory (default: ~/.local/bin)
#   SEVDESK_MCP_VERSION  release to install, e.g. 0.2.0 (default: latest)
#   SEVDESK_MODE         mode for the client entries: read, write or full (default: the setup asks)
#   NO_COLOR             disable colors (https://no-color.org)
#
# Strict POSIX sh. Everything runs inside main(), which is called on the last line, so a
# truncated download executes nothing.

set -eu

REPO=altipard/sevdesk-mcp
RELEASES="https://github.com/$REPO/releases"
BIN_NAME=sevdesk-mcp
KEYCHAIN_SERVICE=sevdesk-mcp
KEYCHAIN_ACCOUNT=api-token
# Terminal the setup talks to: under `curl | sh` stdin is the script itself.
TTY_IN=/dev/tty
TTY_OUT=/dev/tty

tmp=''
stage=''

cleanup() {
    if [ -n "$stage" ]; then rm -f "$stage"; fi
    if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
    return 0
}

# --- terminal handling ------------------------------------------------------------------------

# Sets ESC, BOLD, DIM, ACC, RST (empty without color), COLOR_MODE (none/256/truecolor), ART (0/1).
# Color only if stdout is a terminal (fd 1, not stdin: `curl | sh` pipes stdin), NO_COLOR is
# empty and TERM is set and not dumb. The logo is drawn without color otherwise.
init_ui() {
    ESC=$(printf '\033')
    BOLD=''; DIM=''; ACC=''; RST=''
    COLOR_MODE=none; ART=0
    if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ -n "${TERM:-}" ] && [ "${TERM:-}" != dumb ]; then
        case "${COLORTERM:-}" in
            truecolor | 24bit) COLOR_MODE=truecolor ;;
            *) COLOR_MODE=256 ;;
        esac
        art_color fg L
        BOLD="${ESC}[1m"; DIM="${ESC}[2m"; ACC="${ESC}[${acode}m"; RST="${ESC}[0m"
    fi
    # The logo needs UTF-8 half-block glyphs.
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
        *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*) ART=1 ;;
    esac
    ERR_RED=''; ERR_RST=''
    if [ "$COLOR_MODE" != none ] && [ -t 2 ]; then ERR_RED="${ESC}[1;31m"; ERR_RST="${ESC}[0m"; fi
}

say() { printf '  %s\n' "$*"; }
blank() { printf '\n'; }

fail() {
    printf '%ssevdesk-mcp installer: error:%s %s\n' "$ERR_RED" "$ERR_RST" "$*" >&2
    exit 1
}

# --- logo -------------------------------------------------------------------------------------

# Palette of assets/logo/sevdesk-mcp.txt. Sets p_rgb (truecolor) and p_256 (xterm 256).
art_pal() {
    case $1 in
        K) p_rgb='29;23;48';    p_256=235 ;; # outline, pupils #1d1730
        P) p_rgb='107;79;160';  p_256=61 ;;  # plumage #6b4fa0
        L) p_rgb='165;139;216'; p_256=140 ;; # breast feathers #a58bd8
        C) p_rgb='247;243;234'; p_256=255 ;; # face, belly #f7f3ea
        Y) p_rgb='242;201;76';  p_256=221 ;; # beak, feet #f2c94c
    esac
}

# art_color fg|bg LETTER -> acode (SGR parameters for the active color mode)
art_color() {
    art_pal "$2"
    case "$COLOR_MODE:$1" in
        truecolor:fg) acode="38;2;$p_rgb" ;;
        truecolor:bg) acode="48;2;$p_rgb" ;;
        *:fg) acode="38;5;$p_256" ;;
        *:bg) acode="48;5;$p_256" ;;
    esac
}

# Two pixel rows per terminal row: the top pixel is the foreground of "▀", the bottom pixel its
# background, "▄" if only the bottom is set, "█" if both match. Without color the outline is drawn
# in the terminal's foreground color.
art_render() {
    while IFS= read -r top && IFS= read -r bot; do
        line='  '
        cur=''
        while [ -n "$top" ]; do
            t=${top%"${top#?}"}
            top=${top#?}
            b=${bot%"${bot#?}"}
            bot=${bot#?}
            if [ "$COLOR_MODE" = none ]; then
                # Only outline, pupils, beak and feet: the filled shape alone reads as a blob.
                case "$t" in [KY]) ;; *) t=. ;; esac
                case "$b" in [KY]) ;; *) b=. ;; esac
                case "$t$b" in
                    ..) line="${line} " ;;
                    ?.) line="${line}▀" ;;
                    .?) line="${line}▄" ;;
                    *) line="${line}█" ;;
                esac
                continue
            fi
            glyph=' '
            style=''
            if [ "$t" = . ] && [ "$b" = . ]; then
                :
            elif [ "$t" = "$b" ]; then
                glyph='█'
                art_color fg "$t"
                style=$acode
            elif [ "$b" = . ]; then
                glyph='▀'
                art_color fg "$t"
                style=$acode
            elif [ "$t" = . ]; then
                glyph='▄'
                art_color fg "$b"
                style=$acode
            else
                glyph='▀'
                art_color fg "$t"
                style=$acode
                art_color bg "$b"
                style="$style;$acode"
            fi
            if [ "$style" != "$cur" ]; then
                if [ -z "$style" ]; then
                    line="${line}${ESC}[0m"
                else
                    line="${line}${ESC}[0;${style}m"
                fi
                cur=$style
            fi
            line="${line}${glyph}"
        done
        if [ "$COLOR_MODE" = none ]; then
            printf '%s\n' "$line"
        else
            printf '%s%s[0m\n' "$line" "$ESC"
        fi
    done <<'ART'
.K............K.
.KK..........KK.
.KPK........KPK.
.KPPKKKKKKKKPPK.
KPPPPPPPPPPPPPPK
KPKKKKPPPPKKKKPK
KKCCCCKPPKCCCCKK
KKCKKCKKKKCKKCKK
KKCKKCKPPKCKKCKK
KKCCCCKPPKCCCCKK
KPKKKKPYYPKKKKPK
KPPPPPPYYPPPPPPK
KPPPPCCCCCCPPPPK
KPPPCCLCCLCCPPPK
KPPPCCCCCCCCPPPK
KPPPCCLCCLCCPPPK
.KPPCCCCCCCCPPK.
..KKPPCCCCPPKK..
....KKKKKKKK....
.....YY..YY.....
ART
}

# --- download and install ---------------------------------------------------------------------

usage() {
    cat <<'EOF'
sevdesk-mcp installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh -s -- [options]

Options:
  --dry-run        show platform, release and target without downloading or changing anything
  --no-setup       install only, skip the guided setup
  --mode=MODE      mode for the client entries: read, write or full (default: the setup asks)
  --replace-token  ask for a new token even if one is already in the keychain
  --replace-entries
                   also replace a "sevdesk" entry that has its own command or settings
  --no-verify      store the token without checking it against the sevdesk API
  -h, --help       show this help

Environment:
  INSTALL_DIR          target directory (default: ~/.local/bin)
  SEVDESK_MCP_VERSION  release to install, e.g. 0.2.0 (default: latest)
  SEVDESK_MODE         same as --mode (the option wins)
  NO_COLOR             disable colors

With a terminal the installer then runs `sevdesk-mcp setup`, which asks for the agents
(MCP clients found on this machine are preselected), global or project configuration, the
mode and the sevdesk API token, shows a plan and carries it out after one confirmation. The
token goes into the system keychain (service sevdesk-mcp, account api-token), never into a
client configuration file. The options above are passed on; `sevdesk-mcp setup --help` lists
all of its options, including the ones for running it without prompts.
EOF
}

# Sets OS, ARCH (names as used by the release assets: sevdesk-mcp-<os>-<arch>).
detect_platform() {
    os=$(uname -s)
    arch=$(uname -m)
    case "$os" in
        Linux) OS=linux ;;
        Darwin) OS=darwin ;;
        *) fail "unsupported operating system: $os (releases exist for Linux and macOS; on other systems use: npx -y @altipard/sevdesk-mcp)" ;;
    esac
    case "$arch" in
        x86_64 | amd64) ARCH=x64 ;;
        aarch64 | arm64) ARCH=arm64 ;;
        *) fail "unsupported architecture: $arch (releases exist for x64 and arm64)" ;;
    esac
    # A shell under Rosetta reports x86_64 on Apple Silicon; install the native binary.
    if [ "$OS" = darwin ] && [ "$ARCH" = x64 ]; then
        if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm64; fi
    fi
    if [ "$OS" = linux ] && is_musl; then
        fail "this system uses musl libc (e.g. Alpine), the release binaries need glibc. Use the npm package instead: npx -y @altipard/sevdesk-mcp. Nothing was installed."
    fi
}

# The Linux binaries link against glibc and do not start on musl systems.
is_musl() {
    if [ -f /etc/alpine-release ]; then return 0; fi
    case "$(ldd --version 2>&1 || true)" in
        *musl*) return 0 ;;
        *GNU* | *GLIBC* | *glibc*) return 1 ;;
    esac
    # No usable ldd: a musl loader without a glibc loader.
    for loader in /lib/ld-musl-*.so.1; do
        if [ -e "$loader" ] && [ ! -e /lib64/ld-linux-x86-64.so.2 ] && [ ! -e /lib/ld-linux-aarch64.so.1 ]; then
            return 0
        fi
    done
    return 1
}

fetch() { # url file
    curl -fsS --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --retry 2 -L -o "$2" "$1"
}

# Sets SHA256_TOOL (sha256sum on Linux, shasum on macOS).
find_sha256() {
    for candidate in sha256sum shasum; do
        if command -v "$candidate" >/dev/null 2>&1; then
            SHA256_TOOL=$candidate
            return 0
        fi
    done
    return 1
}

sha256_of() { # file
    case "$SHA256_TOOL" in
        sha256sum) sum=$(sha256sum "$1") || return 1 ;;
        shasum) sum=$(shasum -a 256 "$1") || return 1 ;;
    esac
    printf '%s\n' "${sum%% *}"
}

# Sets VERSION and PINNED. With $1 = dry, "latest" is not looked up.
resolve_version() {
    if [ -n "${SEVDESK_MCP_VERSION:-}" ] && [ "${SEVDESK_MCP_VERSION:-}" != latest ]; then
        VERSION=${SEVDESK_MCP_VERSION#v}
        PINNED=1
    elif [ "${1:-}" = dry ]; then
        VERSION=latest
        PINNED=0
        return 0
    else
        final=$(curl -fsSIL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 \
            -o /dev/null -w '%{url_effective}' "$RELEASES/latest") ||
            fail "cannot reach github.com to look up the latest release"
        # Without a published release GitHub redirects .../releases/latest to .../releases.
        case "${final%/}" in
            */releases) fail "no release published yet at $RELEASES. Use the npm package instead (npx -y @altipard/sevdesk-mcp) or set SEVDESK_MCP_VERSION." ;;
        esac
        VERSION=${final##*/}
        PINNED=0
    fi
    # The tag ends up in a URL: accept only a plain version string.
    case "$VERSION" in
        [0-9]*) ;;
        *) fail "could not determine a release version (got '$VERSION'); set SEVDESK_MCP_VERSION" ;;
    esac
    case "$VERSION" in
        *[!0-9A-Za-z.+-]*) fail "invalid release version '$VERSION'" ;;
    esac
}

# Sets DEST (directory).
choose_dest() {
    if [ -n "${INSTALL_DIR:-}" ]; then
        DEST=${INSTALL_DIR%/}
    elif [ -n "${HOME:-}" ]; then
        DEST="$HOME/.local/bin"
    else
        fail "HOME is not set; set INSTALL_DIR"
    fi
    case "$DEST" in
        /*) ;;
        *) fail "INSTALL_DIR must be an absolute path (got '$DEST')" ;;
    esac
}

# Fail before downloading anything if the target is not usable.
prepare_dest() {
    mkdir -p "$DEST" 2>/dev/null || fail "cannot create $DEST; set INSTALL_DIR to a writable directory"
    [ -w "$DEST" ] || fail "no write access to $DEST; set INSTALL_DIR to a writable directory"
    if [ -d "$DEST/$BIN_NAME" ]; then
        fail "$DEST/$BIN_NAME is a directory; remove it or set INSTALL_DIR. Nothing was installed."
    fi
}

verify_checksum() {
    fetch "$RELEASES/download/$VERSION/SHA256SUMS" "$tmp/SHA256SUMS" ||
        fail "could not download SHA256SUMS of release $VERSION. Nothing was installed."
    say "Verifying checksum..."
    expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
    # Exactly one SHA-256: anything else (missing, duplicate, malformed) is refused.
    case "$expected" in
        '' | *[!0-9a-f]*) fail "no valid checksum for $asset in SHA256SUMS. Nothing was installed." ;;
    esac
    [ "${#expected}" -eq 64 ] || fail "no valid checksum for $asset in SHA256SUMS. Nothing was installed."
    actual=$(sha256_of "$tmp/$asset") || fail "could not compute the checksum of $asset. Nothing was installed."
    [ "$actual" = "$expected" ] ||
        fail "checksum mismatch for $asset; the download is corrupt or has been tampered with. Nothing was installed."
}

# Prints the version a freshly downloaded sevdesk-mcp binary reports in its MCP initialize
# answer, or nothing. Only used on the staged download, never on an existing file.
# It runs with a dummy token and an unreachable base URL, so it neither asks the keychain nor
# reaches sevdesk, and it is stopped after 10 seconds.
binary_version() { # binary
    out="$tmp/initialize.out"
    : >"$out"
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"sevdesk-mcp-installer","version":"0"}}}' |
        env -i PATH=/usr/bin:/bin SEVDESK_API_TOKEN=00000000000000000000000000000000 \
            SEVDESK_BASE_URL=http://127.0.0.1:9/api/v1 LOG_LEVEL=error "$1" >"$out" 2>/dev/null &
    pid=$!
    (sleep 10 && kill "$pid") >/dev/null 2>&1 &
    watchdog=$!
    wait "$pid" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null || true
    sed -n 's/.*"serverInfo":{[^}]*"version":"\([0-9A-Za-z.+-]*\)".*/\1/p' "$out" | head -n 1
}

# Sets BIN_PATH and REPLACED (1 if a file was there before). The existing file is never run:
# it may not be ours, and its version does not matter for the replacement.
install_binary() { # downloaded-file
    target="$DEST/$BIN_NAME"
    # A random name in the target directory: same file system, so the rename below is atomic
    # and a running server keeps its binary; nobody can pre-create the name.
    stage=$(mktemp "$DEST/.$BIN_NAME.XXXXXX") || fail "cannot create a temporary file in $DEST"
    cp "$1" "$stage" || fail "cannot write to $DEST"
    chmod 755 "$stage"
    reported=$(binary_version "$stage")
    [ "$reported" = "$VERSION" ] ||
        fail "the downloaded binary does not run on this system (it reported '${reported:-nothing}', expected $VERSION). Nothing was installed."
    REPLACED=0
    if [ -e "$target" ] || [ -L "$target" ]; then REPLACED=1; fi
    mv -f "$stage" "$target" || fail "cannot replace $target"
    stage=''
    BIN_PATH=$target
}

# --- guided setup -----------------------------------------------------------------------------

# The setup talks to the terminal, not to stdin: under `curl | sh` stdin is the script itself.
# A failed redirection of a special builtin ends a POSIX shell, so probe in a subshell.
has_tty() {
    (: </dev/tty) 2>/dev/null
}

# Returns 0 if the installed binary has the `setup` command. A release without it ignores the
# argument and starts the server, so the probe runs like binary_version: no environment, a dummy
# token (the keychain is not asked), an unreachable base URL, stdin closed, stopped after 10
# seconds. Only the usage line of `setup --help` counts.
supports_setup() {
    out="$tmp/setup-help.out"
    : >"$out"
    env -i PATH=/usr/bin:/bin SEVDESK_API_TOKEN=00000000000000000000000000000000 \
        SEVDESK_BASE_URL=http://127.0.0.1:9/api/v1 LOG_LEVEL=error \
        "$BIN_PATH" setup --help </dev/null >"$out" 2>/dev/null &
    pid=$!
    (sleep 10 && kill "$pid") >/dev/null 2>&1 &
    watchdog=$!
    wait "$pid" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null || true
    grep -q '^Usage: sevdesk-mcp setup' "$out"
}

# Sets TTY_DEV to the terminal's own device (e.g. /dev/ttys003, /dev/pts/1), else TTY_IN. The
# binary is compiled with bun, which cannot read /dev/tty itself on macOS (kqueue refuses that
# device), so the setup gets the device behind it.
terminal_device() {
    TTY_DEV=$TTY_IN
    [ "$TTY_IN" = /dev/tty ] || return 0
    dev=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ') || dev=''
    case "$dev" in
        '' | *'?'* | *[!A-Za-z0-9/]* | */../* | ../*) return 0 ;;
    esac
    if [ -c "/dev/$dev" ] && [ -r "/dev/$dev" ] && [ -w "/dev/$dev" ]; then TTY_DEV="/dev/$dev"; fi
}

# Runs `sevdesk-mcp setup` on the terminal with the options given to the installer. The setup
# asks for everything else (agents, scope, mode, token) and does the backups, the keychain and
# the client configurations itself. Its exit status never fails the installation.
run_setup() {
    set -- setup
    # Without --mode or SEVDESK_MODE the setup asks for the mode.
    if [ "$MODE_FLAG" = 1 ] || [ -n "${SEVDESK_MODE:-}" ]; then set -- "$@" "--mode=$MODE"; fi
    if [ "$REPLACE_TOKEN" = 1 ]; then set -- "$@" --replace-token; fi
    if [ "$REPLACE_ENTRIES" = 1 ]; then set -- "$@" --replace-entries; fi
    if [ "$VERIFY_TOKEN" = 0 ]; then set -- "$@" --no-verify; fi
    # Ctrl-C belongs to the setup now: it finishes or cancels cleanly, then the installer
    # continues here instead of exiting under it.
    terminal_device
    out_dev=$TTY_OUT
    if [ "$TTY_DEV" != "$TTY_IN" ]; then out_dev=$TTY_DEV; fi
    trap ':' INT
    status=0
    "$BIN_PATH" "$@" <"$TTY_DEV" >"$out_dev" || status=$?
    trap 'exit 130' INT
    case "$status" in
        0) ;;
        130) say "Setup cancelled. Run it again any time: $BIN_PATH setup" ;;
        *) say "The setup did not finish (exit $status). Run it again: $BIN_PATH setup" ;;
    esac
}

print_store_command() {
    case "$OS" in
        darwin) say "  security add-generic-password -U -s $KEYCHAIN_SERVICE -a $KEYCHAIN_ACCOUNT -w" ;;
        linux) say "  secret-tool store --label=$KEYCHAIN_SERVICE service $KEYCHAIN_SERVICE account $KEYCHAIN_ACCOUNT" ;;
    esac
}

print_next_steps() {
    if [ "${SETUP_CMD:-0}" = 1 ]; then
        say "Next: run the guided setup in a terminal:"
        say "  $BIN_PATH setup"
        say "It stores the token in the keychain and registers the server with your MCP clients."
        return 0
    fi
    say "Next: store the token with"
    print_store_command
    say "and point your MCP client at $BIN_PATH."
}

# --- main -------------------------------------------------------------------------------------

# Every way out runs cleanup, which also turns terminal echo back on (QUIT is Ctrl-\).
set_traps() {
    trap cleanup EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 131' QUIT
    trap 'exit 143' TERM
}

main() {
    DRY_RUN=0
    SETUP=1
    REPLACE_TOKEN=0
    REPLACE_ENTRIES=0
    VERIFY_TOKEN=1
    MODE=${SEVDESK_MODE:-read}
    MODE_FLAG=0
    for arg in "$@"; do
        case "$arg" in
            -h | --help) usage; exit 0 ;;
            --dry-run) DRY_RUN=1 ;;
            --no-setup) SETUP=0 ;;
            --mode=*) MODE=${arg#--mode=}; MODE_FLAG=1 ;;
            --replace-token) REPLACE_TOKEN=1 ;;
            --replace-entries) REPLACE_ENTRIES=1 ;;
            --no-verify) VERIFY_TOKEN=0 ;;
            *) printf 'sevdesk-mcp installer: unknown option %s (see --help)\n' "$arg" >&2; exit 2 ;;
        esac
    done

    init_ui
    # SEVDESK_MODE only matters for the setup: without one, an odd value in the environment
    # must not stop an install that worked before.
    if [ "$MODE_FLAG" = 1 ] || { [ "$SETUP" = 1 ] && [ -n "${SEVDESK_MODE:-}" ] && has_tty; }; then
        case "$MODE" in
            read | write | full) ;;
            *) fail "unknown mode '$MODE' (from --mode or SEVDESK_MODE); use read, write or full" ;;
        esac
    fi
    set_traps

    blank
    if [ "$ART" = 1 ]; then
        art_render
        blank
    fi
    say "${BOLD}sevdesk-mcp installer${RST}${DIM} - MCP server for the sevdesk API${RST}"
    blank

    detect_platform
    asset="$BIN_NAME-$OS-$ARCH"
    choose_dest
    # The path ends up in JSON and shell snippets.
    case "$DEST" in
        *[!-A-Za-z0-9_./\ ~+@:,]*) fail "INSTALL_DIR contains unsupported characters: $DEST" ;;
    esac

    if [ "$DRY_RUN" = 1 ]; then
        resolve_version dry
        if [ "$VERSION" = latest ]; then
            url="$RELEASES/latest/download/$asset"
        else
            url="$RELEASES/download/$VERSION/$asset"
        fi
        say "Dry run, nothing is downloaded or changed."
        say "platform:  $OS-$ARCH"
        say "release:   $VERSION"
        say "asset:     $url"
        say "checksums: ${url%/*}/SHA256SUMS"
        say "target:    $DEST/$BIN_NAME"
        blank
        return 0
    fi

    command -v curl >/dev/null 2>&1 || fail "curl is required but was not found"
    find_sha256 || fail "found neither sha256sum nor shasum, so the download cannot be verified. Nothing was installed."
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/sevdesk-mcp-install.XXXXXX") || fail "cannot create a temporary directory"

    resolve_version
    prepare_dest

    if [ "$PINNED" = 1 ]; then
        say "Using ${ACC}$VERSION${RST} for $OS-$ARCH"
    else
        say "Found ${ACC}$VERSION${RST} for $OS-$ARCH"
    fi
    say "Downloading..."
    fetch "$RELEASES/download/$VERSION/$asset" "$tmp/$asset" ||
        fail "download failed: $RELEASES/download/$VERSION/$asset (does release $VERSION exist for $OS-$ARCH?)"
    verify_checksum
    install_binary "$tmp/$asset"

    blank
    if [ "$REPLACED" = 1 ]; then
        say "Replaced the existing ${BOLD}$BIN_PATH${RST} with sevdesk-mcp ${ACC}$VERSION${RST}"
    else
        say "${BOLD}sevdesk-mcp${RST} ${ACC}$VERSION${RST} installed to ${BOLD}$BIN_PATH${RST}"
    fi
    say "${DIM}Build provenance: gh attestation verify $BIN_PATH --repo $REPO${RST}"
    case ":${PATH:-}:" in
        *":$DEST:"*) ;;
        *)
            blank
            say "$DEST is not on your PATH. MCP clients use the full path, so this only matters"
            say "for running it by hand. Add it with:"
            say "  export PATH=\"$DEST:\$PATH\""
            ;;
    esac

    SETUP_CMD=0
    if supports_setup; then SETUP_CMD=1; fi
    blank
    if [ "$SETUP" = 1 ] && [ "$SETUP_CMD" = 1 ] && has_tty; then
        run_setup
    else
        if [ "$SETUP" = 1 ] && [ "$SETUP_CMD" = 0 ]; then
            say "This release has no guided setup."
        fi
        print_next_steps
    fi
    blank
}

main "$@"
