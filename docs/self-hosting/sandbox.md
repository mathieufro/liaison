---
title: The app sandbox service
description: Sandboxed apps run on workerd under gVisor on your own server - install gVisor, install the firewall step, upgrade to it, size it, and the risks it does not remove.
---

Apps that are not part of Liaison's core (the bundled apps, apps you install, your organizations' own apps) run in a sandbox. On a self-hosted server that sandbox can be the **sandbox service**: a supervised pool of `workerd` processes (the runtime behind Cloudflare Workers) in its own container, under gVisor, on a network that reaches nothing but one port of the app. It is part of every stack: the compose file starts it and points the app at it, so a fresh or upgraded server runs every sandboxed app on workerd. Before you start or upgrade, install gVisor on the host (below); after the stack is up, install the firewall step.

What the service does for each run:

- One process serves one organization's app at one version at a time, and is never reused for another organization. It is replaced after 100 runs or 2 idle minutes.
- A run past its time is killed (its deadline plus 1 second), as is a run past its CPU time (read from the process) or a process past its memory cap (`SANDBOX_RSS_CAP_MB`, with a V8 heap of `SANDBOX_HEAP_MB`). Other organizations' runs go on.
- Nested runs (an app calling another app, a PDF render inside a tool) get processes kept for them, at most 4 deep, so a chain never waits on itself.
- A run holds no key and no secret: it gets a token for that run only, and every `ctx.*` call goes back to the app, which checks the token.

## Install gVisor

The service declares `runtime: runsc`, so Docker refuses to start it on a host without gVisor. gVisor needs no KVM (the default `systrap` platform works on any cloud VM). On Debian or Ubuntu:

```sh
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install
sudo systemctl reload docker
```

Check it: `docker run --rm --runtime=runsc busybox dmesg` prints gVisor's boot lines.

## How it runs

`docker compose up -d` from `deploy/` starts the service with the rest of the stack; the app reaches it at `LIAISON_SANDBOX_URL`, `http://sandbox:8790` unless you set another. Every app process gets a second listener on port 3100 (`LIAISON_APP_BRIDGE_PORT`) that answers `/api/app-bridge/<run>` and nothing else, and joins the sandbox network. The service sends each run's `ctx.*` calls back to the process that sent the run, at the address the run came from (under gVisor the sandbox cannot use Docker's name service, so no name or fixed address is involved). This works the same for the single `app` container and for the rolling `api` and `worker` processes of `deploy/rolling-deploy.sh`, old and new side by side. Each sandboxed app whose installed version carries a Worker module (`worker.js`, every bundled app does) runs on the service; its timing lines say `executor: "workerd"` and its usage rows count under `workerd`, with the CPU time the service measured for each run.

The app's `/healthz` shows the service as the `sandbox` dependency: `ok` when it answers with the app's release and can reach that process's bridge listener, `release_mismatch` or `bridge_unreachable` otherwise.

### The way back, this release only

`LIAISON_APP_RUNTIME=quickjs` in `deploy/.env`, then `docker compose up -d`: every app runs on the local QuickJS sandbox again, whatever else is set. It is the only way back while a server moves to the service, and it is temporary: the next release removes QuickJS and this switch, so a server must run its apps on the service before it takes that release. While the switch is on, `/healthz` does not list the service as a dependency. A host where the service cannot start at all (no gVisor yet) can leave it out meanwhile with `docker compose up -d --scale sandbox=0`, together with the switch. On such a host `sudo deploy/sandbox-firewall.sh install` still puts the rules in place, and `deploy/sandbox-firewall.sh check` passes with a line saying there is nothing to check while no sandbox service runs and the app runs on QuickJS; run it again once the service runs.

## Upgrading to the release that turns it on

The service used to be optional (the `sandbox` compose profile and `LIAISON_SANDBOX_URL`). From this release it starts with the stack, so before you upgrade:

1. **Install gVisor** on the host (below). Without it `docker compose up -d` stops at the `sandbox` service with Docker's `unknown or invalid runtime name: runsc`, and the app is not recreated.
2. **Upgrade as usual** (`docker compose pull && docker compose up -d`, or `deploy/rolling-deploy.sh`). The service is created on the new image with the app, and recreated with it on every later upgrade (below). `COMPOSE_PROFILES=sandbox` and `LIAISON_SANDBOX_URL=http://sandbox:8790` in an existing `deploy/.env` still work; they are no longer needed.
3. **Install the firewall step**: `sudo deploy/sandbox-firewall.sh install`, then `deploy/sandbox-firewall.sh check` (below). Until it is installed the service refuses every run with `sandbox_network_open` and `/healthz` says so: install it right after the upgrade, or set `LIAISON_APP_RUNTIME=quickjs` until you can.
4. **Size it** for the host (below) and lower the app's own memory limit by what the service takes.
5. **Check every installed app can run there**: `/healthz` (with the `MONITOR_TOKEN`) reports `appsWithoutWorkerModule`, the active app versions with no Worker module. It must be `0`. At start the server gives such a version the `worker.js` of its own stored package when that package has one; a version still counted has to be reinstalled, or republished from a package built by this release, before its runs work (they are refused with `app_worker_module_missing` meanwhile). `dependencies.sandbox` must say `ok`.

If anything goes wrong, `LIAISON_APP_RUNTIME=quickjs` (above) puts every app back where it ran before, without a downgrade.

## Upgrades

The service runs the same image as the app and must run the same release. Every request the app sends it names the app's release; a service of another release refuses the run (`sandbox_release_mismatch`, with the command to fix it), its container health check turns unhealthy, and the app's `/healthz` reports `release_mismatch`. So after an upgrade the service is recreated with the app:

- Single `app` container: `docker compose up -d` (or `docker compose up -d app`: the app depends on the service, so it is recreated too when its image moved).
- Rolling deploys: `deploy/rolling-deploy.sh` recreates the service on the new image as soon as the new `api` and `worker` processes are ready, before the old ones drain, and starts it there when none runs yet (the first rolling deploy of this release; not while `LIAISON_APP_RUNTIME=quickjs`). Sandboxed runs still started by the old processes are refused from then on.
- By hand: `docker compose up -d sandbox`.

The compose file gives the service exactly the app's image: both read `LIAISON_IMAGE`, through one definition. To pull from your own registry (Amazon ECR, a private registry), set `LIAISON_IMAGE` to that image, for example `LIAISON_IMAGE=<account>.dkr.ecr.<region>.amazonaws.com/liaison:v0.3.0`: the app, the service and the rolling `api`, `worker` and `migrate` processes all follow. Do not set `image:` on `app` alone in an override file; if you must, set the same value on `sandbox` too. `deploy/sandbox-firewall.sh check` fails when the service and an app process run different images.

## Install the firewall step

A Docker network marked `internal` has no route out, but its containers still reach the host on the network's gateway address (an SSH server, anything bound to `0.0.0.0`) and every port of the other containers on it, the app's main port included. The firewall step closes that: from the sandbox service only the app's bridge port answers.

```sh
sudo deploy/sandbox-firewall.sh install   # rules now, and a systemd unit for every boot
deploy/sandbox-firewall.sh check          # from inside the sandbox: only the bridge port answers
```

`check` prints one line per probe for every running app process on the sandbox network (`app`, or the rolling `api` and `worker` processes: each one's bridge port must answer and its main port must be blocked; the host's SSH port, the cloud metadata address and a public address must be blocked too), then one per workerd process (each runs as its own uid, and another uid cannot open its environment or memory), and exits non-zero on any miss. `sudo deploy/sandbox-firewall.sh remove` takes the rules away.

### The service checks it too

The service does not take the firewall step on trust. At start, every hour, and every 30 seconds while it finds a problem, it tries to connect from its own network to every app process's main port (`SANDBOX_PROBE_APP_PORTS`, 3000), to the host on its gateway address (`SANDBOX_PROBE_GATEWAY_PORTS`: 22, 80, 443, 2375, 3000, 5432, 6379) and to the cloud metadata address. If any of them accepts, it logs an error naming them, refuses every app run with `sandbox_network_open`, and the app's `/healthz` reports `sandbox: network_open`, until a check finds them all closed again (a health check looks again at once, so `/healthz` turns `ok` as soon as the step is installed). The app container's own Docker health check ignores that one value, so the stack can start before you install the step.

A development stack on a laptop, with no firewall step, may accept the risk: `LIAISON_SANDBOX_ALLOW_OPEN_NETWORK=1`. Runs then go on, and every check that finds the network open logs a warning. Never set it on a server that runs other people's apps.

The script finds the stack and its settings the way `docker compose` does, so give it the same options you give compose, before the command:

```sh
sudo deploy/sandbox-firewall.sh -p liaison --env-file /srv/liaison/liaison.env install
deploy/sandbox-firewall.sh -p liaison --env-file /srv/liaison/liaison.env check
```

It accepts `-p`/`--project-name`, `--env-file` (several allowed) and `-f`/`--file` (default `deploy/docker-compose.yml`), and honours `COMPOSE_PROJECT_NAME` from the environment or the env file. Without `--env-file` it reads `deploy/.env`, as compose does. The settings it reads (environment first, then the env files) are the compose file's: `LIAISON_SANDBOX_SUBNET`, `LIAISON_SANDBOX_IP`, `LIAISON_SANDBOX_BRIDGE` (liaison-sbx0) and `LIAISON_APP_BRIDGE_PORT` (3100). `install` writes the options and values into the systemd unit.

On the sandbox network the rules let through only an app process's connection to the service and the service's connection to an app process's bridge port; anything else coming from that network is dropped. `apply` and `check` stop with an error when the live network's subnet, or the service's address, is not the one in the settings.

## Network address

The sandbox network is a /24 with the service at a fixed address in it, both set in `deploy/.env`:

```sh
LIAISON_SANDBOX_SUBNET=10.73.250.0/24
LIAISON_SANDBOX_IP=10.73.250.10
```

Those are the defaults. They avoid the ranges clouds and tools use by default: AWS's default VPC (172.31.0.0/16) and Docker's own address pools (172.17.0.0/16 to 172.31.0.0/16, 192.168.0.0/16), the VPCs AWS, Azure and Hetzner propose (10.0.0.0/16, 10.1.0.0/16), Google Cloud's auto mode (10.128.0.0/9), DigitalOcean's VPCs, Kubernetes, k3s and Podman networks, and Tailscale (100.64.0.0/10). If your host or its VPC already uses 10.73.250.0/24, pick another free /24 and set both values: compose and the firewall script read the same two names. The address must be inside the subnet.

### An install that ran the sandbox before this change

Earlier versions put the network on 172.31.250.0/24, with the service at 172.31.250.10. Docker recreates the network when its subnet changes, so upgrading without a setting would move it while the firewall unit still names the old address. To keep the network where it is, pin the old values in `deploy/.env` before you upgrade:

```sh
LIAISON_SANDBOX_SUBNET=172.31.250.0/24
LIAISON_SANDBOX_IP=172.31.250.10
```

To move to the new default (required on a host inside an AWS default VPC, where 172.31.250.0/24 collides), set the new values, then `docker compose up -d`, then `sudo deploy/sandbox-firewall.sh install` again (with your `-p`/`--env-file`) so the unit names the new network, and `deploy/sandbox-firewall.sh check`. Until the firewall step is reinstalled, the rules drop the network's traffic and sandboxed runs fail; `LIAISON_APP_RUNTIME=quickjs` keeps apps running meanwhile.

## Size it

The pool sizes itself from what you give the service: `LIAISON_SANDBOX_MEM_LIMIT` (2g) and `LIAISON_SANDBOX_CPUS` (2.0), which the compose file sets as the container's limits and passes to the service (`SANDBOX_SERVICE_MEM_LIMIT`, `SANDBOX_SERVICE_CPUS`). It runs as many processes as that memory holds at `SANDBOX_RSS_CAP_MB` (256), less `SANDBOX_POOL_OVERFLOW` (2), and at most 4 per CPU, between 2 and 32. A third of the pool (1 to 4, none under 3 processes) is kept for nested runs, and a third (at least 1) for interactive runs. Without those two variables (the service run outside the compose file), it reads the limits of its cgroup, else the host's. So you only change the memory and CPUs:

| Memory and CPUs for the sandbox | Pool | Kept for nested runs | Kept for interactive runs | Background runs at once |
|---|---|---|---|---|
| 1 GiB, 1 CPU | 2 + 2 overflow | 0 | 1 | 1 |
| 2 GiB, 2 CPUs (the defaults) | 6 + 2 | 2 | 2 | 2 |
| 3 GiB, 3 CPUs | 10 + 2 | 3 | 3 | 4 |
| 8 GiB, 4 CPUs | 16 + 2 | 4 | 5 | 7 |

`SANDBOX_POOL_SIZE`, `SANDBOX_POOL_RESERVED` and `SANDBOX_POOL_RESERVED_INTERACTIVE` set in your `.env` win over what is derived, each on its own. The worst case is every process at its memory cap: (pool + `SANDBOX_POOL_OVERFLOW`) x `SANDBOX_RSS_CAP_MB`, which the derived pool keeps within the memory limit. Measured use is far below it (about 130 MiB for six loaded processes). The service logs the sizes it runs with at start (`poolSize`, `reserved`, `reservedInteractive`, `laneCaps`, and `sizing`: the memory and CPUs it read and where from), and `GET /stats` on it shows them under `sizes`.

Memory the service takes comes out of the host's budget: on a host whose app container has a memory limit, lower that limit by the service's. For a 16 GB host, for example, an app limit of 8 GiB becomes 6 GiB with the default 2 GiB service.

**Interactive and background runs.** Runs that a person or an agent waits on (tool calls, attention computes, summarizers, page reads) are interactive; jobs, event handlers, webhook deliveries and syncs are background. Of the pool, `SANDBOX_POOL_RESERVED` processes are kept for nested runs, and `SANDBOX_POOL_RESERVED_INTERACTIVE` more for interactive runs: background runs hold at most the pool less both (2 with the defaults, at least 1), interactive runs the pool less the nested reserve (4). So when many long jobs start together, they wait their turn and tool calls still start at once. An interactive run waits for a process until its own deadline, then fails with a timeout: a person waits on it. A scheduled or queued job's run, and a knowledge source sync's, waits on a clock of its own instead: up to `LIAISON_SANDBOX_BACKGROUND_QUEUE_MS` (set on the app, 10 minutes by default, between 1 second and 60 minutes), and its deadline (the job's manifest `timeoutMs`, 60 s when unset) starts once a process takes it. So a dozen jobs that start at the top of the hour run in turn, each with its whole budget. A run still waiting past that bound fails with `queue_timeout`: it never started, and the job is put back on its queue a minute later without spending one of its attempts (for up to an hour, then it fails as any error). Other background runs (webhook deliveries, which run inside the sender's request, event handlers, polls, imports) and any run that holds a database transaction keep the deadline that counts the wait. If jobs often wait minutes at the top of the hour, give the pool more processes. The service logs its lane caps at start, and `GET /stats` on it shows them with each lane's busy and waiting runs and its wait counters (`pool.lanes`, `pool.counters.lanes`: runs started, how many waited and how long, runs whose queue bound passed), each lane's queue rule (`sizes.queueLimits`), and in `recent` each run's `queueMs`, its `queueLimitMs` and whether its deadline counted from its `start` or its `arrival` (`deadlineFrom`).

A job's run that mostly waits on calls back to the app (a provider's API, the database) still holds a sandbox process for that whole time. The pool is sized for that today; the next step is to let such a run give its process back while it waits.

`SANDBOX_RSS_CAP_MB` (256) and `SANDBOX_HEAP_MB` (128) set one process's cap; `SANDBOX_RECYCLE_RUNS` (100) and `SANDBOX_IDLE_MS` (120000) when a process is replaced.

## A host without gVisor

Not recommended: tenants' code is then separated from the host's kernel by a container only. If you must, set both:

```sh
LIAISON_SANDBOX_RUNTIME=runc
LIAISON_SANDBOX_ALLOW_NO_GVISOR=1
```

The service refuses to start with the first alone, and with both it logs a warning at start and every hour.

## One uid per process

Each workerd process runs as its own user id (from 40000; `SANDBOX_PROCESS_UID_BASE` and `SANDBOX_PROCESS_UID_COUNT`, 64, change the range), with no supplementary group and no capability, in a private directory that holds its socket and its temporary files. A run that escaped V8 in one organization's process cannot read another process's memory or environment (its key and its runs' tokens), nor open its socket. For that the service runs as root inside its container with five capabilities only (`SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, `KILL`), as the compose file sets it. Started otherwise (as another user, or with `SANDBOX_PROCESS_UIDS=off`), every process shares one uid and the service warns at start and every hour.

## Risks it does not remove

- **Tenants share a host.** Every organization on the server runs its apps on the same machine. gVisor and workerd isolate them; they do not make them separate machines.
- **No Spectre guard.** gVisor does not mitigate Spectre-class side channels, and workerd's own mitigations assume Cloudflare's process isolation model.
- **Timers.** `Date.now()` is live (not frozen between I/O as on Cloudflare) and `performance.now()` has 1 ms resolution.
- **SharedArrayBuffer exists.** With live clocks it allows building finer timers.

## Development and CI

No container: the same supervisor and the same pinned `workerd` binary run directly (`bun run packages/sandbox-supervisor/src/main.ts` with `SANDBOX_BRIDGE_ORIGIN` set), and the tests start it in process. There is no setting that turns the sandbox off.
