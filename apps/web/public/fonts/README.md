# Resume PDF font assets

The embedded PDF export uses subsetted Noto Sans Regular and Bold assets from
the upstream [Noto Sans v2.015 release](https://github.com/notofonts/latin-greek-cyrillic/releases/tag/NotoSans-v2.015).
The upstream archive contains `NotoSans/hinted/ttf/NotoSans-Regular.ttf`,
`NotoSans/hinted/ttf/NotoSans-Bold.ttf`, and `OFL.txt`. The license included
beside these subsets is the upstream OFL-1.1 license. The upstream copyright
notice does not declare a Reserved Font Name.

The subset files were produced with FontTools `pyftsubset` 4.68.0 from the
v2.015 static TTF files. To reproduce them, extract those source files and run
the following commands from this directory (with `pyftsubset` on `PATH`):

```sh
pyftsubset NotoSans-Regular.ttf --output-file=NotoSans-Regular-subset.ttf --unicodes="U+0000-024F,U+0300-036F,U+0370-03FF,U+0400-052F,U+1C80-1C8F,U+1F00-1FFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2150-218F,U+2190-21FF,U+2212-22FF,U+2DE0-2DFF,U+A640-A69F"
pyftsubset NotoSans-Bold.ttf --output-file=NotoSans-Bold-subset.ttf --unicodes="U+0000-024F,U+0300-036F,U+0370-03FF,U+0400-052F,U+1C80-1C8F,U+1F00-1FFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2150-218F,U+2190-21FF,U+2212-22FF,U+2DE0-2DFF,U+A640-A69F"
```

The subset request is intentionally broader than the product's supported
codepoint allowlist. The runtime allowlist is defined in
`apps/web/src/lib/resume-pdf.ts`; `resume-pdf.test.ts` verifies every allowed
codepoint maps to a nonzero glyph in both actual subset cmaps. Text outside the
supported and mapped set uses the print/save fallback.

SHA-256:

- `NotoSans-Regular-subset.ttf`: `D394201BD1F14ED9C01292EF27367386BED33356629DD11F4E633057D09C55B4`
- `NotoSans-Bold-subset.ttf`: `191899C7C5BAEB4FDC27C2E95E948D665FA902A1ADD319D040139AB3BA3B4393`
