"""
生成海角 App 图标。
站点自带的 appicon.png 只有 74x74，做不了 App 图标，这里按站点配色（深底 + 玫红）自制。
输出 1024x1024 的 icon.png，交给 Xcode 的 universal 单尺寸图标即可。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "ios", "Haijiao", "Resources", "Assets.xcassets", "AppIcon.appiconset")
os.makedirs(OUT_DIR, exist_ok=True)

SIZE = 1024
BG = (18, 18, 22)          # 近黑
ACCENT = (224, 36, 94)     # 站点主色玫红
SEA_TOP = (34, 34, 44)
SEA_BOT = (58, 22, 40)

img = Image.new("RGB", (SIZE, SIZE), BG)
d = ImageDraw.Draw(img)

# 竖直渐变底
for y in range(SIZE):
    t = y / SIZE
    r = int(SEA_TOP[0] * (1 - t) + SEA_BOT[0] * t)
    g = int(SEA_TOP[1] * (1 - t) + SEA_BOT[1] * t)
    b = int(SEA_TOP[2] * (1 - t) + SEA_BOT[2] * t)
    d.line([(0, y), (SIZE, y)], fill=(r, g, b))

# 三道海浪弧线
for i, (off, w, alpha) in enumerate([(0, 26, 220), (120, 18, 150), (240, 12, 90)]):
    top = 620 + off
    d.arc([-260 - i * 40, top, SIZE + 260 + i * 40, top + 420],
          start=200, end=340, fill=(*ACCENT, alpha), width=w)

# 中间的字：海
try:
    font = None
    for cand in (
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
    ):
        if os.path.exists(cand):
            font = ImageFont.truetype(cand, 480)
            break
    if font is None:
        raise RuntimeError("no CJK font")
    text = "海"
    box = d.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    d.text(((SIZE - tw) / 2 - box[0], (SIZE - th) / 2 - box[1] - 90),
           text, font=font, fill=(255, 255, 255))
except Exception as e:
    print("字体排版跳过:", e)
    # 退路：画个圆环
    d.ellipse([SIZE * 0.28, SIZE * 0.22, SIZE * 0.72, SIZE * 0.66],
              outline=ACCENT, width=44)

# 底部细线
d.rectangle([SEA_TOP and SIZE * 0.32, 872, SIZE * 0.68, 880], fill=ACCENT)

png = os.path.join(OUT_DIR, "icon-1024.png")
img.save(png, "PNG")
print("生成:", png, img.size)

# Xcode 15 支持单尺寸 1024，但仍写一份 Contents.json 明确指定
contents = """{
  "images" : [
    {
      "filename" : "icon-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
"""
with open(os.path.join(OUT_DIR, "Contents.json"), "w", encoding="utf-8") as f:
    f.write(contents)
print("生成: Contents.json")
