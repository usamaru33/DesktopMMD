# PyInstaller spec: one-folder build of the sidecar.
#   npm run sidecar:build   (→ sidecar/dist/sidecar/sidecar.exe)
# Models are not bundled; they download to %APPDATA%\mmd-assistant\models on first start.
import os
import site
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, copy_metadata

datas = collect_data_files('faster_whisper') + collect_data_files('onnxruntime') + collect_data_files('certifi')
# huggingface_hub decides whether hf_xet (fast model downloads) is installed by reading package metadata
# (importlib.metadata), so the dist-info has to be bundled along with the module itself.
datas += copy_metadata('hf_xet') + copy_metadata('huggingface_hub')
binaries = collect_dynamic_libs('ctranslate2') + collect_dynamic_libs('onnxruntime') + collect_dynamic_libs('tokenizers')

# CUDA: Whisper only loads cuBLAS. Keep the nvidia/<pkg>/bin layout that stt.add_cuda_dll_dirs() looks for.
for root in site.getsitepackages():
    cublas = os.path.join(root, 'nvidia', 'cublas', 'bin')
    for dll in ('cublas64_12.dll', 'cublasLt64_12.dll'):
        p = os.path.join(cublas, dll)
        if os.path.exists(p):
            binaries.append((p, os.path.join('nvidia', 'cublas', 'bin')))

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=['vad', 'stt', 'embed', 'websockets.asyncio.server', 'websockets.asyncio.client', 'tokenizers', 'huggingface_hub', 'hf_xet'],
    excludes=['tkinter', 'matplotlib', 'torch', 'IPython', 'pytest'],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='sidecar', console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name='sidecar', upx=False)
