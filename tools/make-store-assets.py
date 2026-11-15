#!/usr/bin/env python3
"""Generate Chrome Web Store / Edge Add-ons promotional tiles (Pillow required).

Depends on `python tools/make-icons.py` having produced:
  store-assets/icon-512.png  (transparent master)
  store-assets/logo-300.png  (Edge 1:1 logo)

Not part of the extension package: `tools/package.mjs` only ships the INCLUDE list.
Run: python tools/make-icons.py && python tools/make-store-assets.py
"""

from pathlib import Path
from shutil import copyfile

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'store-assets'
OUT.mkdir(exist_ok=True)

BLUE = (26, 115, 232)
WHITE = (255, 255, 255)

CN = 'C:/Windows/Fonts/msyh.ttc'
CN_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'

try:
    LANCZOS = Image.Resampling.LANCZOS
except AttributeError:  # Pillow < 9.1
    LANCZOS = Image.LANCZOS

MASTER = OUT / 'icon-512.png'
if not MASTER.exists():
    raise SystemExit('缺少 store-assets/icon-512.png，请先运行 python tools/make-icons.py')


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def paste_icon(image, x, y, size):
    """Place the real extension icon on a white rounded tile (blue background)."""
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        [x, y, x + size, y + size], radius=int(size * 0.16), fill=WHITE
    )
    pad = int(size * 0.06)
    tile = Image.open(MASTER).convert('RGBA').resize(
        (size - 2 * pad, size - 2 * pad), LANCZOS
    )
    image.paste(tile, (x + pad, y + pad), tile)


def canvas(width, height, background=WHITE):
    image = Image.new('RGB', (width, height), background)
    return image, ImageDraw.Draw(image)


def save(image, name):
    image.save(OUT / name, 'PNG')
    print(f'  {name}  {image.width}x{image.height}')


# Edge Add-ons 1:1 logo is produced by make-icons.py from the source artwork.
# Fall back to the 512 master if someone runs this script standalone.
logo = OUT / 'logo-300.png'
if not logo.exists():
    image, _ = canvas(300, 300)
    tile = Image.open(MASTER).convert('RGBA').resize((282, 282), LANCZOS)
    image.paste(tile, (9, 9), tile)
    image.save(logo, 'PNG')
    print('  logo-300.png  300x300 (fallback)')

# Optional small promo tile (both stores: 440x280).
image, draw = canvas(440, 280, BLUE)
paste_icon(image, 26, 78, 124)
draw.text((172, 96), '离线双语翻译', font=load_font(CN_BOLD, 21), fill=WHITE)
draw.text((172, 138), '本地引擎 · 零网络请求 · OCR', font=load_font(CN, 11), fill=WHITE)
save(image, 'promo-small-440x280.png')

# Optional marquee / large promo tile (both stores: 1400x560).
image, draw = canvas(1400, 560, BLUE)
paste_icon(image, 100, 130, 300)
draw.text((470, 176), '离线双语翻译', font=load_font(CN_BOLD, 52), fill=WHITE)
draw.text(
    (470, 272),
    'Bergamot 本地引擎 · 翻译零网络请求 · 双语对照 / 划词 / OCR',
    font=load_font(CN, 22),
    fill=WHITE,
)
save(image, 'promo-large-1400x560.png')

# Chrome Web Store store icon (128x128) — same file as the extension's icon.
copyfile(ROOT / 'assets/icons/icon-128.png', OUT / 'store-icon-128.png')
print('  store-icon-128.png  128x128 (copied from assets/icons)')
