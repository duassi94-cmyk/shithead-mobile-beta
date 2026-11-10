"""Gera os ícones do app (PNG) sem bibliotecas externas.

Uso (na pasta do repositório):  py tests/make-icons.py [variante]
Saída: icons/icon-192.png, icons/icon-512.png, icons/apple-touch-icon.png (180)

Desenho: mesa de feltro verde (fundo opaco, como o iPhone exige) com duas cartas em
leque e um único elemento que traduz o jogo (variantes):
  giro   — anel de duas setas em volta das cartas: a mesa gira, tudo pode mudar
  virada — a carta de trás fechada e uma seta curva até a carta aberta
  sortes — a carta espelhada: coração vermelho em cima, o mesmo de ponta-cabeça embaixo
  classico — só as cartas (versão anterior)
Tudo fica dentro do círculo central de 80% (área segura dos ícones "maskable" do
Android). Bordas suavizadas pela distância até a forma; detalhes com superamostragem.
O mesmo desenho está em icons/icon.svg (favicon).
"""
import math
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'icons')
DEFAULT_VARIANT = 'giro'


def png_bytes(w, h, rows):
    raw = b''.join(b'\x00' + bytes(r) for r in rows)

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def over(dst, src, alpha):
    return tuple(dst[i] * (1 - alpha) + src[i] * alpha for i in range(3))


def rrect_sdf(px, py, cx, cy, hw, hh, r, ang):
    # ponto no sistema da carta (girada de ang radianos em torno do centro)
    c, s = math.cos(-ang), math.sin(-ang)
    dx, dy = px - cx, py - cy
    x, y = dx * c - dy * s, dx * s + dy * c
    qx, qy = abs(x) - (hw - r), abs(y) - (hh - r)
    out = math.hypot(max(qx, 0), max(qy, 0))
    return out + min(max(qx, qy), 0) - r, x, y


def heart_inside(u, v, size, flip=False):
    # coração implícito: (x²+y²−1)³ − x²y³ ≤ 0 (y para cima)
    x = u / size
    y = (v if flip else -v) / size + 0.12
    return (x * x + y * y - 1) ** 3 - x * x * y ** 3 <= 0


def ang_in(a, a0, a1):
    """a dentro do arco de a0 a a1 (graus, sentido horário na tela)."""
    a, a0, a1 = a % 360, a0 % 360, a1 % 360
    return a0 <= a <= a1 if a0 <= a1 else (a >= a0 or a <= a1)


def arc_sdf(x, y, cx, cy, R, t, a0, a1):
    a = math.degrees(math.atan2(y - cy, x - cx))
    if ang_in(a, a0, a1):
        return abs(math.hypot(x - cx, y - cy) - R) - t / 2
    d = min(math.hypot(x - (cx + R * math.cos(math.radians(e))), y - (cy + R * math.sin(math.radians(e)))) for e in (a0, a1))
    return d - t / 2


def arrow_head(cx, cy, R, ang, length, width, cw=True):
    """Triângulo da ponta da seta no fim de um arco (aponta na direção do giro)."""
    a = math.radians(ang)
    px, py = cx + R * math.cos(a), cy + R * math.sin(a)
    tx, ty = (-math.sin(a), math.cos(a)) if cw else (math.sin(a), -math.cos(a))  # tangente
    nx, ny = math.cos(a), math.sin(a)  # normal (para fora)
    tip = (px + tx * length * 0.7, py + ty * length * 0.7)
    b1 = (px - tx * length * 0.3 + nx * width / 2, py - ty * length * 0.3 + ny * width / 2)
    b2 = (px - tx * length * 0.3 - nx * width / 2, py - ty * length * 0.3 - ny * width / 2)
    return (tip, b1, b2)


def in_tri(x, y, tri):
    (x1, y1), (x2, y2), (x3, y3) = tri
    d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
    d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


BG_IN, BG_OUT = hexrgb('#1b6b5f'), hexrgb('#0b1120')
AMBER, RED, ORANGE = hexrgb('#fbbf24'), hexrgb('#ef4444'), hexrgb('#f97316')
WHITE, EDGE = hexrgb('#f8fafc'), hexrgb('#cbd5e1')
HEART, DARK = hexrgb('#e11d48'), hexrgb('#334155')
ACCENT = hexrgb('#fcd34d')
BACK = dict(cx=222, cy=262, hw=96, hh=134, r=22, ang=math.radians(-14))
FRONT = dict(cx=292, cy=252, hw=96, hh=134, r=22, ang=math.radians(10))


def variant_shapes(variant):
    """Elementos extras de cada variante, em unidades de 512 px."""
    sh = {'ring': [], 'heads': [], 'hearts': [(0, 0, 54, False, HEART)]}
    if variant == 'giro':
        # anel atrás das cartas: dois arcos com ponta (sentido horário)
        c = (256, 256)
        R, t = 184, 10  # anel + pontas cabem no círculo seguro de 80% (204,8 px em 512)
        for a0, a1 in ((200, 318), (20, 138)):
            sh['ring'].append((c[0], c[1], R, t, a0, a1))
            sh['heads'].append(arrow_head(c[0], c[1], R, a1, 38, 32))
    elif variant == 'virada':
        # seta curva por cima: da carta fechada (esquerda) para a aberta (direita)
        c = (262, 300)
        R, t = 232, 13
        sh['ring'].append((c[0], c[1], R, t, 232, 290))
        sh['heads'].append(arrow_head(c[0], c[1], R, 290, 44, 40))
    elif variant == 'sortes':
        sh['hearts'] = [(0, -50, 36, False, HEART), (0, 50, 36, True, DARK)]
    return sh


def render(size, variant=DEFAULT_VARIANT):
    k = size / 512.0
    shapes = variant_shapes(variant)
    plain_back = variant == 'virada'  # verso liso: carta fechada
    rows = []
    ss = [((sx + 0.5) / 4 - 0.5, (sy + 0.5) / 4 - 0.5) for sy in range(4) for sx in range(4)]
    for j in range(size):
        row = []
        for i in range(size):
            x, y = (i + 0.5) / k, (j + 0.5) / k
            # fundo: feltro com luz no centro
            d = math.hypot(x - 256, y - 230) / 330
            col = mix(BG_IN, BG_OUT, min(1.0, d) ** 1.4)
            # anel/seta (atrás das cartas)
            for (cx, cy, R, t, a0, a1) in shapes['ring']:
                sd = arc_sdf(x, y, cx, cy, R, t, a0, a1)
                a = max(0.0, min(1.0, 0.5 - sd * k))
                if a > 0:
                    col = over(col, ACCENT, a * 0.92)
            for tri in shapes['heads']:
                xs = [p[0] for p in tri]
                ys = [p[1] for p in tri]
                if min(xs) - 2 <= x <= max(xs) + 2 and min(ys) - 2 <= y <= max(ys) + 2:
                    hits = sum(1 for du, dv in ss if in_tri(x + du / k, y + dv / k, tri))
                    if hits:
                        col = over(col, ACCENT, hits / 16 * 0.92)
            for card, front in ((BACK, False), (FRONT, True)):
                # sombra suave (deslocada para baixo)
                sd, _, _ = rrect_sdf(x, y, card['cx'] + 8, card['cy'] + 12, card['hw'], card['hh'], card['r'], card['ang'])
                if sd < 22:
                    col = over(col, (0, 0, 0), 0.38 * max(0.0, min(1.0, (22 - sd) / 22)) ** 1.6)
                sdf, u, v = rrect_sdf(x, y, card['cx'], card['cy'], card['hw'], card['hh'], card['r'], card['ang'])
                a = max(0.0, min(1.0, 0.5 - sdf * k))
                if a <= 0:
                    continue
                if front:
                    fill = WHITE if sdf < -3 else EDGE
                elif sdf < -12:
                    t = max(0.0, min(1.0, (u + v * 0.6 + 140) / 280))
                    fill = mix(AMBER, ORANGE if plain_back else RED, t)
                    # losangos discretos no verso
                    if (int((u + v) // 26) + int((u - v) // 26)) % 2 == 0:
                        fill = mix(fill, (1, 1, 1), 0.10)
                else:
                    fill = WHITE
                col = over(col, fill, a)
                if front and sdf < -6:
                    for (hu, hv, hs, flip, hcol) in shapes['hearts']:
                        if abs(u - hu) < hs * 1.3 and abs(v - hv) < hs * 1.3:
                            hits = sum(1 for du, dv in ss if heart_inside(u - hu + du / k, v - hv + dv / k, hs, flip))
                            if hits:
                                col = over(col, hcol, hits / 16)
            row.extend(max(0, min(255, round(c * 255))) for c in col)
        rows.append(row)
    return rows


if __name__ == '__main__':
    variant = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VARIANT
    os.makedirs(OUT, exist_ok=True)
    for name, size in (('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180)):
        open(os.path.join(OUT, name), 'wb').write(png_bytes(size, size, render(size, variant)))
        print('icons/' + name, size, variant)
