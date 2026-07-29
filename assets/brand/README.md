# HomeAgent Brand Assets

The HomeAgent mark is a warm, persistent intelligence sheltered under a roof:
the roof represents `Home`, and the centered four-point hearth spark represents
an Agent that understands and acts.

## Canonical Sources

- `homeagent-mark.svg` is the complete full-color source.
- `homeagent-glyph.svg` is the background-adaptive monochrome/two-tone source.
- PNG files and `HomeAgent.icns` are generated release inputs, not geometry
  sources.

The mark center is `(90, 90)` in a `0 0 180 180` viewBox. Keep one spark-width
of clear space around the visible mark. Never replace the hearth spark with a
heart, chat bubble, brain, robot head, or generic standalone AI sparkle.

## Palette

| Name | Value |
|---|---|
| Morning terracotta | `#DA7B51` |
| Primary terracotta | `#C45F43` |
| Deep terracotta | `#A94733` |
| Hearth gold | `#F4C965` |
| Warm cream | `#FFF3E5` |
| Hearth ink | `#342A25` |

No other literal colors belong in canonical SVG assets.

## Responsive Rules

| Display size | Variant |
|---|---|
| `>=128px` | Gradient background, roof, home, spark, halo, detail spark |
| `48–127px` | Flat terracotta background, roof, home, two-tone spark |
| `24–47px` | Flat compact mark with heavier roof and simplified spark |
| `16–23px` | No background; monochrome roof, home, and solid spark |

Do not mechanically shrink the complete 1024px artwork to compact sizes. The
halo and decorative detail spark are never notification or runtime state.

## Feishu Safe Area

The 512px Feishu avatar uses a solid terracotta field. Keep the roof and hearth
spark within the center circle whose diameter is 80% of the square so Feishu's
circular crop does not clip critical geometry. Upload remains a manual
administrator action.

## Verification

Run:

```powershell
bun run verify:brand
```

Verification is offline and rejects active SVG content, external references,
off-palette colors, and missing geometry IDs. Once responsive PNG derivatives
are present, the same command also validates their format and dimensions.
