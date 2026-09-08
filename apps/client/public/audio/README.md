# Audio assets

## Background music

- `epidemic-home-theme.mp3`
- Title: **Play Me Like That Video Game**
- Artist: Josef Bel Habib
- Source: https://www.epidemicsound.com/music/tracks/f989a01d-1d73-3266-b4ed-ba26ed1e1b84/
- License: Epidemic Sound licensed download supplied by the project owner; use and distribution remain subject to the owner's Epidemic Sound agreement.
- SHA-256: `09D9500B2E5032C2F06C2B39E8084A6EACFEC5E5D59ED316A1B11F44D9279096`
- Playback scope: continuous after the first browser interaction. The track has a permanent 25% base gain, multiplied by the user's music setting. It uses that volume on the home page, lobby, and result modal, then halves it during a match and its final animation.

The clash, card, interface, result, and heart sounds are synthesized at runtime by
`apps/client/src/audio.ts` and do not use third-party samples.
