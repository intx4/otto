"""Generate icons/icon{16,32,48,128}.png with the Python standard library only.

The icon is a rounded dark square holding three stacked bars in tab-group colors.
Run from the repository root: python3 scripts/make_icons.py
"""

import pathlib
import struct
import zlib

BACKGROUND = (32, 33, 36)
BARS = [(26, 115, 232), (30, 142, 62), (249, 171, 0)]
SIZES = [16, 32, 48, 128]
SUPERSAMPLE = 4


def inside_rounded_rect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and x0 <= x <= x1 and y0 <= y <= y1


def color_at(u, v):
    """u, v in [0, 1). Returns an RGBA tuple."""
    if not inside_rounded_rect(u, v, 0.0, 0.0, 1.0, 1.0, 0.22):
        return (0, 0, 0, 0)
    widths = [0.68, 0.52, 0.36]
    for i, (color, width) in enumerate(zip(BARS, widths)):
        top = 0.2 + i * 0.22
        if inside_rounded_rect(u, v, 0.16, top, 0.16 + width, top + 0.15, 0.06):
            return (*color, 255)
    return (*BACKGROUND, 255)


def render(size):
    rows = []
    n = SUPERSAMPLE
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(n):
                for sx in range(n):
                    r, g, b, a = color_at((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            alpha = acc[3] / (n * n)
            if acc[3]:
                row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(alpha)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out = pathlib.Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size in SIZES:
        path = out / f"icon{size}.png"
        path.write_bytes(png(size, render(size)))
        print(f"wrote {path.relative_to(out.parent)}")


if __name__ == "__main__":
    main()
