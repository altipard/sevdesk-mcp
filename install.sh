#!/bin/sh
# sevdesk-mcp installer: downloads the release binary for this machine, checks it against the
# release's SHA256SUMS and installs it. With a terminal it then offers to store the sevdesk API
# token in the system keychain and to register the server with MCP clients.
#
#   curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
#
# Environment:
#   INSTALL_DIR          target directory (default: ~/.local/bin)
#   SEVDESK_MCP_VERSION  release to install, e.g. 0.2.0 (default: latest)
#   NO_COLOR             disable colors (https://no-color.org)
#
# Strict POSIX sh. Everything runs inside main(), which is called on the last line, so a
# truncated download executes nothing.

set -eu

REPO=altipard/sevdesk-mcp
RELEASES="https://github.com/$REPO/releases"
BIN_NAME=sevdesk-mcp
SERVER_NAME=sevdesk
KEYCHAIN_SERVICE=sevdesk-mcp
KEYCHAIN_ACCOUNT=api-token

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
  --dry-run    show platform, release and target without downloading or changing anything
  --no-setup   install only, skip the keychain and MCP client setup
  -h, --help   show this help

Environment:
  INSTALL_DIR          target directory (default: ~/.local/bin)
  SEVDESK_MCP_VERSION  release to install, e.g. 0.2.0 (default: latest)
  NO_COLOR             disable colors

The setup runs only with a terminal and asks before every step. It stores the sevdesk API
token in the system keychain (service sevdesk-mcp, account api-token), never in a client
configuration file.
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

# --- interactive setup ------------------------------------------------------------------------

# The setup talks to /dev/tty: under `curl | sh` stdin is the script itself.
# A failed redirection of a special builtin ends a POSIX shell, so probe in a subshell.
has_tty() {
    (: </dev/tty) 2>/dev/null
}

# ask "question" default(y/n) -> exit 0 for yes
ask() {
    if [ "$2" = y ]; then hint='[Y/n]'; else hint='[y/N]'; fi
    printf '  %s %s ' "$1" "$hint" >/dev/tty
    answer=''
    IFS= read -r answer </dev/tty || answer=''
    case "$answer" in
        '') [ "$2" = y ] ;;
        [Yy] | [Yy][Ee][Ss] | [Jj] | [Jj][Aa]) return 0 ;;
        *) return 1 ;;
    esac
}

# Sets MODE.
choose_mode() {
    MODE='read'
    printf '  Mode for the client entries: read, write or full [read] ' >/dev/tty
    answer=''
    IFS= read -r answer </dev/tty || answer=''
    case "$answer" in
        '' | read) MODE='read' ;;
        write | full) MODE=$answer ;;
        *) say "Unknown mode '$answer', using read." ;;
    esac
}

# Sets TOKEN_IN_KEYCHAIN (0/1). The keychain tool prompts for the token itself, so it never
# passes through this script, its arguments or the environment.
store_token() {
    TOKEN_IN_KEYCHAIN=0
    case "$OS" in
        darwin)
            if security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
                if ! ask "A token is already stored in the keychain. Replace it?" n; then
                    TOKEN_IN_KEYCHAIN=1
                    return 0
                fi
            elif ! ask "Store your sevdesk API token in the macOS keychain?" y; then
                return 0
            fi
            say "Paste the token (input is hidden), then confirm it:"
            # -w as the last argument makes security prompt for the value; -U replaces an entry.
            if security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" \
                -l "sevdesk-mcp API token" -w </dev/tty >/dev/tty 2>&1; then
                TOKEN_IN_KEYCHAIN=1
                say "Token stored (service $KEYCHAIN_SERVICE, account $KEYCHAIN_ACCOUNT)."
            else
                say "Storing the token failed; nothing was changed."
            fi
            ;;
        linux)
            if ! command -v secret-tool >/dev/null 2>&1; then
                say "secret-tool (libsecret) is not installed, so the token cannot go into the keychain."
                say "Install it (e.g. apt install libsecret-tools) and run the installer again,"
                say "or set SEVDESK_API_TOKEN in the client configuration yourself."
                return 0
            fi
            if secret-tool lookup service "$KEYCHAIN_SERVICE" account "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
                if ! ask "A token is already stored in the keychain. Replace it?" n; then
                    TOKEN_IN_KEYCHAIN=1
                    return 0
                fi
            elif ! ask "Store your sevdesk API token in the keychain (Secret Service)?" y; then
                return 0
            fi
            say "Paste the token (input is hidden):"
            if secret-tool store --label="sevdesk-mcp API token" \
                service "$KEYCHAIN_SERVICE" account "$KEYCHAIN_ACCOUNT" </dev/tty >/dev/tty 2>&1; then
                TOKEN_IN_KEYCHAIN=1
                say "Token stored (service $KEYCHAIN_SERVICE, account $KEYCHAIN_ACCOUNT)."
            else
                say "Storing the token failed; nothing was changed."
            fi
            ;;
    esac
}

# JSON string contents: escape backslash and double quote. Paths with control characters are
# refused earlier.
json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# The server entry shared by all JSON configurations. Never contains the token.
entry_json() { # extra-fields (e.g. '"type": "stdio", ')
    printf '{ %s"command": "%s", "env": { "SEVDESK_MODE": "%s" } }' "$1" "$(json_escape "$BIN_PATH")" "$MODE"
}

print_snippet() { # file key extra-fields
    say "Add this to $1:"
    blank
    printf '    { "%s": { "%s": %s } }\n' "$2" "$SERVER_NAME" "$(entry_json "$3")"
    blank
}

# merge_json FILE KEY: sets KEY.sevdesk to the server entry, keeps everything else. Needs jq or
# python3; the original is backed up first and only replaced by a complete, valid result.
merge_json() {
    file=$1
    key=$2
    if command -v jq >/dev/null 2>&1; then
        merger=jq
    elif command -v python3 >/dev/null 2>&1; then
        merger=python3
    else
        say "Neither jq nor python3 found, so $file is not changed automatically."
        print_snippet "$file" "$key" ''
        return 0
    fi
    # Any existing content goes through the merger: if it is not valid JSON the file stays.
    if [ -s "$file" ] || [ -L "$file" ]; then
        if [ -L "$file" ]; then
            say "$file is a symbolic link; not changing it."
            print_snippet "$file" "$key" ''
            return 0
        fi
        backup="$file.backup-$(date +%Y%m%d%H%M%S)"
        cp -p "$file" "$backup" || { say "Cannot back up $file; not changing it."; return 0; }
        src=$file
    else
        backup=''
        mkdir -p "$(dirname "$file")" || { say "Cannot create $(dirname "$file")."; return 0; }
        printf '{}\n' >"$tmp/empty.json"
        src="$tmp/empty.json"
    fi
    out="$tmp/merged.json"
    status=0
    case "$merger" in
        jq)
            jq --arg key "$key" --arg name "$SERVER_NAME" --arg cmd "$BIN_PATH" --arg mode "$MODE" '
                if type != "object" then error("not a JSON object") else . end
                | .[$key] = ((.[$key] // {}) | if type == "object" then . else error("not an object") end)
                | .[$key][$name] = { command: $cmd, env: { SEVDESK_MODE: $mode } }
            ' "$src" >"$out" 2>/dev/null || status=$?
            ;;
        python3)
            python3 -I -c '
import json, sys
src, out, key, name, cmd, mode = sys.argv[1:]
with open(src, encoding="utf-8") as f:
    data = json.load(f)
if not isinstance(data, dict):
    sys.exit(1)
servers = data.setdefault(key, {})
if not isinstance(servers, dict):
    sys.exit(1)
servers[name] = {"command": cmd, "env": {"SEVDESK_MODE": mode}}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
' "$src" "$out" "$key" "$SERVER_NAME" "$BIN_PATH" "$MODE" 2>/dev/null || status=$?
            ;;
    esac
    if [ "$status" -ne 0 ] || [ ! -s "$out" ]; then
        # Nothing changed, so the backup would only be clutter.
        if [ -n "$backup" ]; then rm -f "$backup"; fi
        say "$file is not valid JSON (or has an unexpected shape); not changing it."
        print_snippet "$file" "$key" ''
        return 0
    fi
    # Write next to the file and rename: the configuration is never half-written. The copy
    # keeps the mode of an existing file.
    newfile=''
    if newfile=$(mktemp "$(dirname "$file")/.$(basename "$file").XXXXXX") &&
        { [ -z "$backup" ] || cp -p "$file" "$newfile"; } &&
        cat "$out" >"$newfile" &&
        mv -f "$newfile" "$file"; then
        say "Updated $file"
        if [ -n "$backup" ]; then say "${DIM}backup: $backup${RST}"; fi
        return 0
    fi
    if [ -n "$newfile" ]; then rm -f "$newfile"; fi
    if [ -z "$backup" ]; then
        say "Writing $file failed."
    elif cp -p "$backup" "$file"; then
        say "Writing $file failed; restored it from $backup."
    else
        say "Writing $file failed and restoring it failed too; the original is at $backup."
    fi
    print_snippet "$file" "$key" ''
}

server_present() { # file key
    [ -f "$1" ] || return 1
    if command -v jq >/dev/null 2>&1; then
        jq -e --arg key "$2" --arg name "$SERVER_NAME" '.[$key][$name] != null' "$1" >/dev/null 2>&1
    elif command -v python3 >/dev/null 2>&1; then
        python3 -I -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    sys.exit(0 if sys.argv[3] in data.get(sys.argv[2], {}) else 1)
except Exception:
    sys.exit(1)
' "$1" "$2" "$SERVER_NAME" 2>/dev/null
    else
        return 1
    fi
}

setup_json_client() { # label file key
    if ! ask "Register sevdesk-mcp with $1 ($2)?" n; then return 0; fi
    if server_present "$2" "$3" && ! ask "$2 already has a \"$SERVER_NAME\" entry. Replace it?" n; then
        return 0
    fi
    merge_json "$2" "$3"
}

setup_claude_desktop() {
    case "$OS" in
        darwin) file="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
        linux) file="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json" ;;
    esac
    setup_json_client "Claude Desktop" "$file" mcpServers
}

setup_cursor() {
    setup_json_client "Cursor" "$HOME/.cursor/mcp.json" mcpServers
}

setup_claude_code() {
    if ! ask "Register sevdesk-mcp with Claude Code?" n; then return 0; fi
    say "Command:"
    say "  claude mcp add --scope user $SERVER_NAME --env SEVDESK_MODE=$MODE -- \"$BIN_PATH\""
    if command -v claude >/dev/null 2>&1 && ask "Run it now?" y; then
        if claude mcp add --scope user "$SERVER_NAME" --env "SEVDESK_MODE=$MODE" -- "$BIN_PATH"; then
            say "Registered with Claude Code."
        else
            say "The command failed; run it yourself after fixing the cause."
        fi
    fi
}

setup_vscode() {
    if ! ask "Register sevdesk-mcp with VS Code?" n; then return 0; fi
    spec=$(printf '{"name":"%s","type":"stdio","command":"%s","env":{"SEVDESK_MODE":"%s"}}' \
        "$SERVER_NAME" "$(json_escape "$BIN_PATH")" "$MODE")
    say "Command:"
    say "  code --add-mcp '$spec'"
    if command -v code >/dev/null 2>&1 && ask "Run it now?" y; then
        if code --add-mcp "$spec"; then
            say "Registered with VS Code."
        else
            say "The command failed; add the server via \"MCP: Add Server\" in VS Code instead."
        fi
    else
        say "Or add it to .vscode/mcp.json in a workspace:"
        blank
        printf '    { "servers": { "%s": %s } }\n' "$SERVER_NAME" "$(entry_json '"type": "stdio", ')"
        blank
    fi
}

setup() {
    blank
    if ! ask "Set up the token and MCP clients now?" y; then
        say "Skipped. Run the installer again to set up later."
        return 0
    fi
    blank
    store_token
    blank
    choose_mode
    blank
    setup_claude_desktop
    setup_claude_code
    setup_cursor
    setup_vscode
    blank
    if [ "$TOKEN_IN_KEYCHAIN" = 1 ]; then
        say "The server reads the token from the keychain; no client configuration contains it."
    else
        say "No token in the keychain: set SEVDESK_API_TOKEN in the env of each client entry,"
        say "or run the installer again to store it in the keychain."
    fi
    say "Restart the MCP clients to load the server."
}

# --- main -------------------------------------------------------------------------------------

main() {
    DRY_RUN=0
    SETUP=1
    for arg in "$@"; do
        case "$arg" in
            -h | --help) usage; exit 0 ;;
            --dry-run) DRY_RUN=1 ;;
            --no-setup) SETUP=0 ;;
            *) printf 'sevdesk-mcp installer: unknown option %s (see --help)\n' "$arg" >&2; exit 2 ;;
        esac
    done

    init_ui
    trap cleanup EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

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

    if [ "$SETUP" = 1 ] && has_tty; then
        setup
    else
        blank
        say "Next: store the token with"
        case "$OS" in
            darwin) say "  security add-generic-password -U -s $KEYCHAIN_SERVICE -a $KEYCHAIN_ACCOUNT -w" ;;
            linux) say "  secret-tool store --label=sevdesk-mcp service $KEYCHAIN_SERVICE account $KEYCHAIN_ACCOUNT" ;;
        esac
        say "and point your MCP client at $BIN_PATH (or run the installer in a terminal for guided setup)."
    fi
    blank
}

main "$@"
