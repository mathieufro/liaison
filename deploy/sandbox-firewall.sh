#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# The host firewall step of the app sandbox service (docs/self-hosting/sandbox.md).
#
# A Docker network marked `internal` has no route out of the host, but its
# containers still reach the host itself on the bridge's gateway address (sshd,
# a database bound to 0.0.0.0, the Docker API on TCP, ...) and every port of
# every other container on the network. This script closes both for the
# sandbox service:
#
#   INPUT        packets from the sandbox service's address to the host, and any
#                new connection from the sandbox network to the host: dropped
#   DOCKER-USER  packets from it to anything but the app's bridge-only port
#                (LIAISON_APP_BRIDGE_PORT, 3100) on the sandbox subnet: dropped;
#                replies on connections the app opened (app -> sandbox:8790) pass.
#                Any app process on the subnet qualifies (a single `app`, or the
#                rolling `api` and `worker` processes, at whatever address
#                Docker gave them): the service calls each run's bridge back at
#                the address the run came from.
#
# br_netfilter is loaded and bridge-nf-call-iptables set, so traffic between
# two containers on the same bridge goes through those chains too.
#
#   sudo deploy/sandbox-firewall.sh install    rules now + a systemd unit that
#                                               re-applies them at every boot
#   sudo deploy/sandbox-firewall.sh apply      rules now (idempotent)
#   sudo deploy/sandbox-firewall.sh remove     remove the rules and the unit
#        deploy/sandbox-firewall.sh check      probe from inside the running
#                                               sandbox container: only the
#                                               bridge port of each running app
#                                               process answers, and each
#                                               workerd process runs as its own
#                                               uid, unreadable by another
#
# Compose options go before the command, as for `docker compose`, and must be
# the ones the stack runs with: -p/--project-name, --env-file (repeatable),
# -f/--file (repeatable; default deploy/docker-compose.yml). COMPOSE_PROJECT_NAME
# in the environment or in the env file works as it does for compose:
#   deploy/sandbox-firewall.sh -p liaison --env-file /srv/liaison.env check
#
# Settings, read like compose reads them (the environment first, then the env
# files, the last one winning; without --env-file, the .env beside the first
# compose file), with the compose file's defaults:
#   LIAISON_SANDBOX_SUBNET   10.73.250.0/24  the sandbox network (a /24)
#   LIAISON_SANDBOX_IP       10.73.250.10    the sandbox service's address in it
#   LIAISON_SANDBOX_BRIDGE   liaison-sbx0    the network's bridge device
#   LIAISON_APP_BRIDGE_PORT  3100            the app's bridge-only listener
# `apply` and `check` refuse to run when the live network's subnet or the
# service's address differs from these (the rules would protect nothing).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
CHAIN_FWD="LIAISON-SANDBOX-FWD"
CHAIN_IN="LIAISON-SANDBOX-IN"
UNIT="/etc/systemd/system/liaison-sandbox-firewall.service"
SANDBOX_PORT=8790

die() {
  echo "sandbox-firewall: $*" >&2
  exit 1
}

# A single-quoted shell word, for the compose command built below.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

DC="docker compose"
ENV_FILES=""
FIRST_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p | --project-name)
      [ $# -ge 2 ] || die "$1 needs a value"
      DC="$DC -p $(quote "$2")"
      shift 2
      ;;
    --project-name=*)
      DC="$DC -p $(quote "${1#*=}")"
      shift
      ;;
    --env-file)
      [ $# -ge 2 ] || die "$1 needs a value"
      [ -f "$2" ] || die "env file not found: $2"
      DC="$DC --env-file $(quote "$2")"
      ENV_FILES="$ENV_FILES$2
"
      shift 2
      ;;
    --env-file=*)
      [ -f "${1#*=}" ] || die "env file not found: ${1#*=}"
      DC="$DC --env-file $(quote "${1#*=}")"
      ENV_FILES="$ENV_FILES${1#*=}
"
      shift
      ;;
    -f | --file)
      [ $# -ge 2 ] || die "$1 needs a value"
      DC="$DC -f $(quote "$2")"
      FIRST_FILE="${FIRST_FILE:-$2}"
      shift 2
      ;;
    --file=*)
      DC="$DC -f $(quote "${1#*=}")"
      FIRST_FILE="${FIRST_FILE:-${1#*=}}"
      shift
      ;;
    -*) die "unknown option $1 (usage: $0 [-p name] [--env-file file] [-f file] install|apply|remove|check)" ;;
    *) break ;;
  esac
done
if [ -z "$FIRST_FILE" ]; then
  FIRST_FILE="$HERE/docker-compose.yml"
  DC="$DC -f $(quote "$FIRST_FILE")"
fi
# Compose's own default env file: .env in the project directory.
if [ -z "$ENV_FILES" ] && [ -f "$(dirname "$FIRST_FILE")/.env" ]; then
  ENV_FILES="$(dirname "$FIRST_FILE")/.env
"
fi

# A setting: the environment, else the last env file that sets it, else the
# default. Surrounding quotes are dropped, as compose does.
setting() {
  eval "v=\${$1:-}"
  if [ -z "$v" ] && [ -n "$ENV_FILES" ]; then
    v="$(printf '%s' "$ENV_FILES" | while IFS= read -r f; do
      [ -n "$f" ] && awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$f"
    done | awk 'NF { v = $0 } END { print v }')"
    v="$(printf '%s' "$v" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
  fi
  printf '%s' "${v:-$2}"
}

SUBNET="$(setting LIAISON_SANDBOX_SUBNET 10.73.250.0/24)"
SANDBOX_IP="$(setting LIAISON_SANDBOX_IP 10.73.250.10)"
BRIDGE="$(setting LIAISON_SANDBOX_BRIDGE liaison-sbx0)"
BRIDGE_PORT="$(setting LIAISON_APP_BRIDGE_PORT 3100)"

# The firewall and the probes take the network as a /24 (x.y.z.0/24) holding
# the service's address.
PREFIX="$(echo "$SUBNET" | sed -n 's|^\([0-9]*\.[0-9]*\.[0-9]*\.\)0/24$|\1|p')"
[ -n "$PREFIX" ] || die "LIAISON_SANDBOX_SUBNET must be a /24 ending in .0/24 (got '$SUBNET')"
case "$SANDBOX_IP" in
  "$PREFIX"*) ;;
  *) die "LIAISON_SANDBOX_IP ($SANDBOX_IP) is not in LIAISON_SANDBOX_SUBNET ($SUBNET): set both" ;;
esac

# The subnet of the live network on our bridge device, empty when Docker is not
# running or the network does not exist yet.
live_subnet() {
  command -v docker >/dev/null 2>&1 || return 0
  for id in $(docker network ls -q --filter driver=bridge 2>/dev/null); do
    docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$id" 2>/dev/null |
      awk -v b="$BRIDGE" '$1 == b { print $2 }'
  done
}

# The rules are keyed on the configured subnet and address: on another network
# they would protect nothing, so stop loudly.
same_network() {
  live="$(live_subnet | head -n 1)"
  if [ -n "$live" ] && [ "$live" != "$SUBNET" ]; then
    die "the sandbox network ($BRIDGE) runs on $live but the settings say $SUBNET. Set LIAISON_SANDBOX_SUBNET and LIAISON_SANDBOX_IP to the network's values in the env file the stack uses (or pass it with --env-file), or move the network (docs/self-hosting/sandbox.md, \"Network address\")."
  fi
}

need_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "sandbox-firewall: run as root (sudo)" >&2
    exit 1
  fi
}

ipt() { iptables -w "$@"; }

# Create (or empty) a chain of ours, and make sure `parent` jumps to it first.
own_chain() {
  parent="$1"
  chain="$2"
  ipt -N "$chain" 2>/dev/null || ipt -F "$chain"
  while ipt -D "$parent" -j "$chain" 2>/dev/null; do :; done
  ipt -I "$parent" 1 -j "$chain"
}

apply() {
  need_root
  same_network
  # Bridged traffic (container to container on one bridge) through iptables.
  modprobe br_netfilter 2>/dev/null || true
  if [ ! -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
    echo "sandbox-firewall: br_netfilter is not available; the bridge allowlist cannot hold" >&2
    exit 1
  fi
  sysctl -q -w net.bridge.bridge-nf-call-iptables=1
  # DOCKER-USER exists once Docker has started; create it if this runs first
  # (Docker keeps its contents).
  ipt -N DOCKER-USER 2>/dev/null || true
  if ! ipt -C FORWARD -j DOCKER-USER 2>/dev/null; then ipt -I FORWARD 1 -j DOCKER-USER; fi

  # The sandbox service -> the host (its gateway address and any other): drop.
  own_chain INPUT "$CHAIN_IN"
  ipt -A "$CHAIN_IN" -s "$SANDBOX_IP" -j DROP
  # Nothing on the sandbox network opens a connection to the host.
  ipt -A "$CHAIN_IN" -i "$BRIDGE" -m conntrack --ctstate NEW -j DROP

  # On the sandbox network, two kinds of connection only: an app process to
  # the service (:$SANDBOX_PORT), and the service to an app process's
  # bridge-only port; then replies. Everything else entering from the bridge
  # is dropped, so a service whose address moved (a network recreated on
  # other settings) is cut off, not let through.
  own_chain DOCKER-USER "$CHAIN_FWD"
  ipt -A "$CHAIN_FWD" -s "$SANDBOX_IP" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  ipt -A "$CHAIN_FWD" -s "$SANDBOX_IP" -d "$SUBNET" -p tcp --dport "$BRIDGE_PORT" -j RETURN
  ipt -A "$CHAIN_FWD" -s "$SANDBOX_IP" -j DROP
  ipt -A "$CHAIN_FWD" -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  ipt -A "$CHAIN_FWD" -i "$BRIDGE" -s "$SUBNET" -d "$SANDBOX_IP" -p tcp --dport "$SANDBOX_PORT" -j RETURN
  ipt -A "$CHAIN_FWD" -i "$BRIDGE" -j DROP

  # No IPv6 on the sandbox network (the compose file disables it); drop any anyway.
  if command -v ip6tables >/dev/null 2>&1 && [ -e "/proc/sys/net/ipv6/conf/$BRIDGE" ]; then
    sysctl -q -w "net.ipv6.conf.$BRIDGE.disable_ipv6=1" || true
  fi
  echo "sandbox-firewall: rules applied (sandbox $SANDBOX_IP on $SUBNET may reach :$BRIDGE_PORT only)"
}

install_unit() {
  need_root
  apply
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "sandbox-firewall: no systemd; re-run 'apply' at every boot, after Docker starts" >&2
    return 0
  fi
  cat >"$UNIT" <<EOF
[Unit]
Description=Liaison app sandbox firewall (deploy/sandbox-firewall.sh)
After=docker.service network-online.target
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=LIAISON_SANDBOX_IP=$SANDBOX_IP
Environment=LIAISON_SANDBOX_SUBNET=$SUBNET
Environment=LIAISON_SANDBOX_BRIDGE=$BRIDGE
Environment=LIAISON_APP_BRIDGE_PORT=$BRIDGE_PORT
ExecStart=/bin/sh $HERE/sandbox-firewall.sh $(echo "$DC" | sed 's/^docker compose //') apply

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable liaison-sandbox-firewall.service >/dev/null
  echo "sandbox-firewall: installed $UNIT (re-applies at boot)"
}

remove() {
  need_root
  for pair in "INPUT $CHAIN_IN" "DOCKER-USER $CHAIN_FWD"; do
    set -- $pair
    while ipt -D "$1" -j "$2" 2>/dev/null; do :; done
    ipt -F "$2" 2>/dev/null || true
    ipt -X "$2" 2>/dev/null || true
  done
  if [ -f "$UNIT" ]; then
    systemctl disable liaison-sandbox-firewall.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload 2>/dev/null || true
  fi
  echo "sandbox-firewall: removed"
}

# The sandbox-network address of every running app process (`app`, `api`,
# `worker`), one per line.
app_ids() {
  eval "$DC --profile rolling ps -q app api worker" 2>/dev/null || :
}

# The sandbox-network address of a container (empty when it is not on it).
ip_on_net() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" |
    tr ' ' '\n' | awk -v p="$PREFIX" 'index($0, p) == 1' || :
}

app_ips() {
  for id in $(app_ids); do ip_on_net "$id"; done
}

# From inside the sandbox container: only the bridge port of each app process
# accepts a connection, and it serves a run's bridge call path only.
# shellcheck disable=SC2120 # "$@" is the compose command, set inside.
check() {
  same_network
  gateway="${PREFIX}1"
  sid="$(eval "$DC ps -q sandbox" 2>/dev/null | head -n 1 || :)"
  # A host that runs every app on QuickJS (LIAISON_APP_RUNTIME=quickjs, the service left
  # out with --scale sandbox=0) has no sandbox service to check: say so and pass.
  if [ -z "$sid" ]; then
    for id in $(app_ids); do
      if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null |
        grep -qx 'LIAISON_APP_RUNTIME=quickjs'; then
        echo "sandbox-firewall: no sandbox service runs and the app runs every app on QuickJS (LIAISON_APP_RUNTIME=quickjs): nothing to check. Run check again once the service runs."
        exit 0
      fi
    done
  fi
  [ -n "$sid" ] || die "no running sandbox service in this compose project ($DC); pass the -p/--env-file/-f the stack runs with"
  sip="$(ip_on_net "$sid" | head -n 1)"
  [ "$sip" = "$SANDBOX_IP" ] || die "the sandbox service is at '${sip}', the rules name $SANDBOX_IP: set LIAISON_SANDBOX_IP and LIAISON_SANDBOX_SUBNET to what the stack runs with"
  ips="$(app_ips | sort -u | tr '\n' ' ')"
  [ -n "$ips" ] || die "no app process on the sandbox network ($SUBNET) in this compose project ($DC); pass the -p/--env-file/-f the stack runs with"
  echo "sandbox-firewall: app processes on the sandbox network: $ips"
  # The service must run the app's own image (the release handshake refuses
  # every run otherwise).
  simage="$(docker inspect -f '{{.Image}}' "$sid")"
  for id in $(app_ids); do
    aimage="$(docker inspect -f '{{.Image}}' "$id")"
    [ "$aimage" = "$simage" ] || die "the sandbox service runs image $simage but app process $id runs $aimage: recreate the sandbox with the app (docker compose up -d), both on LIAISON_IMAGE"
  done
  echo "sandbox-firewall: sandbox at $SANDBOX_IP on $SUBNET, same image as the app"
  eval "set -- $DC"
  "$@" exec -T -e "APP_IPS=$ips" sandbox bun --eval "
// A TCP connect: 'open' when something accepted it, else 'blocked' (dropped,
// refused or unroutable).
const tcp = (hostname, port) => new Promise((done) => {
  const timer = setTimeout(() => done('blocked (timeout)'), 3000)
  Bun.connect({ hostname, port, socket: {
    open(s) { clearTimeout(timer); s.end(); done('open') },
    data() {},
    error(_s, e) { clearTimeout(timer); done('blocked (' + (e && e.code || e) + ')') },
    connectError(_s, e) { clearTimeout(timer); done('blocked (' + (e && e.code || e) + ')') },
  } }).catch((e) => { clearTimeout(timer); done('blocked (' + (e && e.code || e) + ')') })
})
const apps = process.env.APP_IPS.trim().split(/\\s+/)
const want = [
  ...apps.flatMap((ip) => [[ip, $BRIDGE_PORT, 'open'], [ip, 3000, 'blocked']]),
  ['$gateway', 22, 'blocked'],
  ['$gateway', 3000, 'blocked'],
  ['169.254.169.254', 80, 'blocked'],
  ['1.1.1.1', 443, 'blocked'],
]
let bad = 0
for (const [host, port, expected] of want) {
  const got = await tcp(host, port)
  const ok = got.startsWith(expected)
  if (!ok) bad++
  console.log((ok ? 'ok    ' : 'FAIL  ') + host + ':' + port + ' -> ' + got)
}
// Each bridge port answers a run's call path, and nothing else.
for (const ip of apps) {
  const r = await fetch('http://' + ip + ':$BRIDGE_PORT/healthz', { signal: AbortSignal.timeout(3000) }).catch((e) => String(e))
  const health = typeof r === 'string' ? r : r.status
  if (health !== 404) bad++
  console.log((health === 404 ? 'ok    ' : 'FAIL  ') + ip + ':$BRIDGE_PORT/healthz -> ' + health)
}
process.exit(bad ? 1 : 0)
"
  # Each workerd process runs as its own uid, and another uid can read neither
  # its environment (its key) nor its memory.
  "$@" exec -T sandbox bun --eval "
const { readdirSync, readFileSync } = require('node:fs')
const procs = []
for (const pid of readdirSync('/proc').filter((d) => /^\\d+\$/.test(d))) {
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8')
    if (!/^Name:\\s+workerd/m.test(status)) continue
    procs.push({ pid, uid: Number(/^Uid:\\s+(\\d+)/m.exec(status)[1]) })
  } catch {}
}
let bad = procs.length === 0 ? 1 : 0
if (!procs.length) console.log('FAIL  no workerd process is running in the sandbox')
const uids = new Set(procs.map((p) => p.uid))
const shared = uids.size !== procs.length || uids.has(0) || uids.has(process.getuid())
if (shared) bad++
console.log((shared ? 'FAIL  ' : 'ok    ') + 'workerd processes and their uids: ' + JSON.stringify(procs))
for (const p of procs) {
  const other = 39999
  for (const what of ['environ', 'mem']) {
    // Opening is the test (reading /proc/<pid>/mem at offset 0 fails anyway).
    const r = Bun.spawnSync(['sh', '-c', 'exec 3< /proc/' + p.pid + '/' + what + ' && echo opened'], { uid: other, gid: other, stdout: 'pipe', stderr: 'ignore' })
    const denied = !r.stdout.toString().includes('opened')
    if (!denied) bad++
    console.log((denied ? 'ok    ' : 'FAIL  ') + 'uid ' + other + ' reads /proc/' + p.pid + '/' + what + ' -> ' + (denied ? 'denied' : 'READ'))
  }
}
process.exit(bad ? 1 : 0)
"
}

case "${1:-}" in
  apply) apply ;;
  install) install_unit ;;
  remove) remove ;;
  check) check ;;
  *)
    echo "usage: $0 [-p name] [--env-file file] [-f file] install|apply|remove|check" >&2
    exit 2
    ;;
esac
