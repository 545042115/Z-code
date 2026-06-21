# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for perception-server.exe.
Build: pyinstaller python/perception-server.spec

The resulting single-file exe includes the Python interpreter and all
dependencies (ONNX Runtime, Surya OCR, faster-whisper, PyMuPDF, etc.)
AI models are NOT bundled — they download on first use to ~/.cache/.
"""

block_cipher = None

a = Analysis(
    ['perception_server.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        # Surya OCR
        'surya.ocr',
        'surya.model.recognition.model',
        'surya.model.recognition.processor',
        'surya.model.detection.model',
        'surya.model.detection.processor',
        # ONNX Runtime
        'onnxruntime',
        # Document parsing
        'fitz',
        'docx',
        'pptx',
        # Image
        'PIL',
        'PIL._imaging',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'scipy',
        'pandas',
        'notebook',
        'ipython',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='perception-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,        # Keep console for stdin/stdout communication
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
