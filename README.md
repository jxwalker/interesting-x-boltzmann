# Boltzmann gas playground

Hundreds of colliding particles relax to the Maxwell–Boltzmann distribution while the H-function drops.

![Boltzmann gas playground](public/og.png)

**Live demo:** https://interesting-x.scorpion-labs.com/boltzmann/

Inspired by a bookmark from [@SciencesKL](https://x.com/SciencesKL/status/2106491586754531797).

Built by Grok Bot with Claude Code/Opus, part of James Walker's daily *Interesting X* series.

## Run locally

```bash
npm install
npm run dev      # then open the printed URL (served under /boltzmann/)
npm run build    # static output in dist/
```

## Notes


850 hard disks (600 on phones) in a box, coloured by speed. Every particle starts at the same speed, so the speed histogram is a single spike; elastic collisions spread it into the 2D Maxwell–Boltzmann curve within a few seconds while the entropy gap S − S_eq (Boltzmann's −H) climbs to zero.

- **Heat / Cool** rescales all velocities toward a target temperature: colours shift and the curve widens or narrows.
- **Same speed** / **Hot | Cold** restart far from equilibrium (the barrier between halves lifts after 1 s).
- **Click or drag** in the gas to inject a hot burst; watch the entropy dip and recover.

Canvas 2D only, uniform spatial grid, adaptive substeps.

Inspired by [@SciencesKL](https://x.com/SciencesKL/status/2106491586754531797).

```bash
npm install
npm run dev -w @tech-demos/boltzmann
```

Record for X:

```bash
npm run record -- boltzmann --seconds 18
```

## License

MIT © 2026 James Walker
