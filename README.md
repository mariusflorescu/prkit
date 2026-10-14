<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo/prkit-logo-paper.svg" />
    <img src="assets/brand/logo/prkit-logo-ink.svg" alt="prkit" width="240" />
  </picture>
</h1>

<p align="center">Stay in the loop when agents write the code.</p>

prkit is a local desktop app for reviewing GitHub pull requests across every GitHub account on your machine. It asks your own coding agent to write a guided review of each PR and keeps it current as new commits land.

```sh
vp i                  # install
vp run dev            # server + web; open the URL it prints
vp run dev:desktop    # Electron window, which runs its own server
```

How it fits together: [docs/internals/architecture.md](docs/internals/architecture.md).

The website lives in [apps/www](apps/www): `vp run dev:www` serves it, `vp run build:www` builds it.
