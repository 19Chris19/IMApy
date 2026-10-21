"""Optional macOS artwork build. Requires Pillow and sips; no IMA access.

Not part of installation, CI, or the IMApy runtime.
"""
from pathlib import Path
import argparse
import base64
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets' / 'readme'
XLINK = '{http://www.w3.org/1999/xlink}href'


def render(source, output):
    tree = ET.parse(source)
    # Ephemeral input only: sips cannot resolve relative raster references.
    # Published README images are PNG/GIF, never base64-inflated SVGs.
    for element in tree.iter():
        if element.tag.endswith('}image'):
            file = (source.parent / element.get(XLINK)).resolve()
            if file != (ASSETS / 'source' / 'hero-subject.png').resolve():
                raise ValueError('unexpected artwork reference')
            element.set(XLINK, 'data:image/png;base64,' + base64.b64encode(file.read_bytes()).decode())
    with tempfile.TemporaryDirectory(prefix='imapy-art-') as folder:
        intermediate = Path(folder) / 'composed.svg'
        tree.write(intermediate, encoding='utf-8', xml_declaration=True)
        subprocess.run(['sips', '-s', 'format', 'png', str(intermediate), '--out', str(output)], check=True, capture_output=True)
        im = Image.open(output).convert('RGBA')
        im.save(output, optimize=True)
        return intermediate.read_bytes()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--motion-renderer', type=Path, help='Explicit path to the reviewed render_motion_gif.py')
    args = parser.parse_args()
    render(ASSETS / 'source' / 'hero-layout.svg', ASSETS / 'hero.png')
    workflow = render(ASSETS / 'source' / 'workflow-layout.svg', ASSETS / 'workflow.png')
    if args.motion_renderer:
        import sys
        with tempfile.TemporaryDirectory(prefix='imapy-motion-') as folder:
            file = Path(folder) / 'workflow.svg'
            file.write_bytes(workflow)
            subprocess.run([sys.executable, str(args.motion_renderer), str(file), str(ASSETS / 'workflow.gif'),
                            '--spec', str(ASSETS / 'source' / 'workflow-motion.json')], check=True)
