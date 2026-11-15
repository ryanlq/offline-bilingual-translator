#!/usr/bin/env python3
"""Generate all icon sizes from the source artwork (Pillow required).

Source: tools/icon-source.png (1254x1254 RGBA, transparent background).
The artwork was cut out from a photo/AI render and contains ~77k nearly
invisible colored fringe pixels around the edges; we rebuild a clean alpha
mask before resizing, otherwise they show up as rainbow jaggies on dark
toolbars and in small sizes.

Outputs:
  assets/icons/icon-{16,32,48,128}.png   extension + toolbar icons (transparent)
  store-assets/icon-512.png              high-res transparent master for promos
  store-assets/logo-300.png              Edge Add-ons 1:1 logo (white background)
  store-assets/store-icon-128.png        Chrome Web Store icon

Run: python tools/make-icons.py
Then: python tools/make-store-assets.py   (promotional tiles)
"""

from pathlib import Path
from shutil import copyfile

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools' / 'icon-source.png'
ICONS = ROOT / 'assets' / 'icons'
STORE = ROOT / 'store-assets'
BACKUP = ROOT / '.icon-backup'

try:
    LANCZOS = Image.Resampling.LANCZOS
except AttributeError:  # Pillow < 9.1
    LANCZOS = Image.LANCZOS


def load_clean_icon(path):
    """Return a square, tightly cropped RGBA icon with a clean alpha edge."""
    if not path.exists():
        raise SystemExit(
            f'缺少源图: {path}\n请把原始图标放到 tools/icon-source.png 后重跑。'
        )

    image = Image.open(path).convert('RGBA')
    alpha = image.getchannel('A')

    # 1) Hard-threshold: alpha <= 48 is抠图残留的彩色杂边 / 孤立白点，全部丢弃
    # 2) Median filter: 去掉散落在主体外的孤立噪点（中值滤波不影响大块主体）
    # 3) Slight feather: 让边缘在缩小后不出现锯齿
    mask = alpha.point(lambda v: 255 if v > 48 else 0)
    mask = mask.filter(ImageFilter.MedianFilter(5))
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    image.putalpha(mask)

    # 以清理后的主体外接框为准，居中裁成正方形并留 5% 呼吸空间
    box = mask.point(lambda v: 255 if v > 128 else 0).getbbox()
    if not box:
        raise SystemExit('源图 alpha 通道为空，无法识别主体')
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    side = max(box[2] - box[0], box[3] - box[1]) * 1.05
    half = side / 2
    crop = (
        max(0, int(cx - half)),
        max(0, int(cy - half)),
        min(image.width, int(cx + half)),
        min(image.height, int(cy + half)),
    )
    image = image.crop(crop)

    width, height = image.size
    if width != height:
        size = max(width, height)
        square = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        square.paste(image, ((size - width) // 2, (size - height) // 2))
        image = square
    return image


def resize(icon, size):
    source = icon
    if size <= 32:
        # 16/32 像素下整幅插画的浏览器窗口、离线徽标等细节会糊成一团；
        # 中心裁切放大「中 / A / 双向箭头」这组核心符号，保持可辨识度
        ratio = 0.72 if size == 16 else 0.82
        side = icon.width
        inset = int(side * (1 - ratio) / 2)
        source = icon.crop((inset, inset, side - inset, side - inset))

    result = source.resize((size, size), LANCZOS)
    if size <= 32:
        # 只锐化 RGB、保留干净 alpha
        red, green, blue, alpha = result.split()
        rgb = Image.merge('RGB', (red, green, blue)).filter(
            ImageFilter.UnsharpMask(radius=0.6, percent=70, threshold=2)
        )
        r2, g2, b2 = rgb.split()
        result = Image.merge('RGBA', (r2, g2, b2, alpha))
    return result


def backup_originals():
    """Keep one pristine copy of the old icon set (only on the first run)."""
    if BACKUP.exists():
        return
    BACKUP.mkdir()
    targets = list(ICONS.glob('*.png')) + [
        STORE / 'logo-300.png',
        STORE / 'store-icon-128.png',
        STORE / 'promo-small-440x280.png',
        STORE / 'promo-large-1400x560.png',
    ]
    for target in targets:
        if target.exists():
            copyfile(target, BACKUP / f'{target.parent.name}__{target.name}')
    print(f'  旧素材已备份到 {BACKUP.relative_to(ROOT)}/')


def main():
    ICONS.mkdir(exist_ok=True)
    STORE.mkdir(exist_ok=True)
    backup_originals()

    icon = load_clean_icon(SRC)
    print(f'  源图主体裁切后: {icon.width}x{icon.height} RGBA')

    for size in (16, 32, 48, 128):
        path = ICONS / f'icon-{size}.png'
        resize(icon, size).save(path, 'PNG', optimize=True)
        print(f'  assets/icons/{path.name}  {size}x{size}  {path.stat().st_size} B')

    master = STORE / 'icon-512.png'
    resize(icon, 512).save(master, 'PNG', optimize=True)
    print(f'  store-assets/{master.name}  512x512  {master.stat().st_size} B')

    # Edge 商店 logo：白底，避免透明角在深色/彩色卡片上出现黑边
    logo = Image.new('RGB', (300, 300), (255, 255, 255))
    tile = resize(icon, 282)
    logo.paste(tile, (9, 9), tile)
    logo.save(STORE / 'logo-300.png', 'PNG', optimize=True)
    print('  store-assets/logo-300.png  300x300 (white background)')

    copyfile(ICONS / 'icon-128.png', STORE / 'store-icon-128.png')
    print('  store-assets/store-icon-128.png  128x128')


if __name__ == '__main__':
    main()
