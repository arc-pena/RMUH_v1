"""Build every deliverable."""
import build_3dm, build_step, build_stl, subprocess, sys
build_3dm.main(); build_step.main(); build_stl.main()
subprocess.run([sys.executable, "preview.py"], check=True)
