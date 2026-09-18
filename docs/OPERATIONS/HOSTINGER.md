# Operations — Hostinger Host

The single machine that serves `https://careerscope.tech`.

## Identity

|                 |                                                                                |
| --------------- | ------------------------------------------------------------------------------ |
| Provider        | Hostinger VPS                                                                  |
| Hostname        | `srv1984950.hstgr.cloud`                                                       |
| Address         | `201.18.193.230`                                                               |
| OS              | Ubuntu 24.04 LTS                                                               |
| Resources       | 2 vCPU, 7.8 GiB RAM, 96 GB disk                                                |
| Docker          | Engine 29.x, Compose v5 (from Docker's own repository, not the distro package) |
| Deployment root | `/opt/careerscope`                                                             |

## Access

SSH is **key-only**. Password authentication is disabled.

```
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230
```

Configuration is owned by `/etc/ssh/sshd_config.d/10-careerscope.conf`, written
by [harden-ssh.sh](../../infra/v3/harden-ssh.sh):

| Setting                        | Value               |
| ------------------------------ | ------------------- |
| `PermitRootLogin`              | `prohibit-password` |
| `PasswordAuthentication`       | `no`                |
| `KbdInteractiveAuthentication` | `no`                |
| `PermitEmptyPasswords`         | `no`                |
| `MaxAuthTries`                 | `4`                 |

`PermitRootLogin` is `prohibit-password` rather than `no` on purpose: root is
the only account on the host and deployment authenticates as root with a key.
`no` would lock the operator out. Do not "harden" this without first creating a
non-root deployment user.

The script refuses to disable password authentication unless an authorized key
is already present, and validates with `sshd -t` before reloading.

### Recovery if locked out

Hostinger's hPanel provides a browser VPS console that does not use SSH. It is
the only recovery path if the key is lost. From there, re-enable password
authentication by removing `/etc/ssh/sshd_config.d/10-careerscope.conf` and
running `systemctl reload ssh`.

## Brute-force protection

fail2ban, configured by [setup-fail2ban.sh](../../infra/v3/setup-fail2ban.sh).

- SSH jail only. 10 failures in 10 minutes, 15 minute ban.
- `banaction = nftables-multiport`, which maintains its own `inet f2b-table`.
  It never flushes the ruleset, so Docker NAT and the CareerScope firewall table
  are untouched.
- `127.0.0.1/8` and `::1` are permanently ignored. Set `OPERATOR_IP` when
  running the script to add your own address.
- Enabled at boot.

Its value here is limited and should be described honestly: password
authentication is already off, so brute force cannot succeed regardless. The
jail cuts log noise and connection churn. **sshd is the control that stops
password guessing, not fail2ban.**

### It will lock you out if you let it

The jail was first configured with `mode = aggressive`. That mode also matches
**pre-authentication disconnects**, which is exactly what a scripted operator or
a CI deploy job looks like: many short-lived connections in quick succession. It
banned the operator's own address within minutes, and it would have banned the
GitHub Actions runner mid-deploy.

The symptom is precise and worth recognising: port 22 times out while 80 and 443
still answer, and the site stays healthy. That is a ban, not an outage.

```
fail2ban-client status sshd
fail2ban-client set sshd unbanip <address>
```

If you are already locked out, SSH cannot help you. Use the **Web console**
button on the hPanel VPS Overview page, or wait out `bantime`.

## Patching

- `unattended-upgrades` is active.
- Check pending security updates and whether a reboot is required:

```
apt-get -s upgrade | grep -c ^Inst
ls /var/run/reboot-required 2>/dev/null && echo "reboot required"
```

The runtime container image also runs `apt-get upgrade` at build time. That is
deliberate: the base image is digest-pinned, so it would otherwise never receive
Debian security fixes. The trade-off is that **the same source commit does not
guarantee identical Debian package bytes** across two builds. Do not claim
otherwise.

## Resources

No swap is configured. This is a decision, not an oversight: 7.8 GiB of RAM
against roughly 1.3 GiB in use leaves ample headroom, and swap on a 2 vCPU box
trades a fast failure for a slow one. Revisit only with evidence of memory
pressure.

Container memory is capped per service in the compose file (`mem_limit`), and
`NODE_OPTIONS=--max-old-space-size=512` bounds each Node heap.

## Logging and disk

- Docker logs are bounded: `json-file`, `max-size: 10m`, `max-file: 5` per
  container.
- Docker build cache is **not** bounded and is the main source of disk growth.
  It reached 17.8 GB once. Reclaim it with:

```
docker builder prune -f --keep-storage 2GB
```

**Never run `docker system prune -a`.** It removes images that rollback depends
on, and it does not distinguish an active volume from a stale one.

Check disk and inodes:

```
df -h /
df -i /
```

## Read-only snapshot

[audit-host.sh](../../infra/v3/audit-host.sh) records the real state of the host
— OS, updates, resources, systemd failures, time sync, listening sockets,
Docker networks, published ports — and changes nothing. Run it before and after
any host change.

## What is not here

There is **no off-host backup**. The Docker volumes on this machine are the only
copy of the database and of stored resumes. This was skipped as an owner
decision on cost. Local volumes are not disaster recovery and must not be
described as such.
