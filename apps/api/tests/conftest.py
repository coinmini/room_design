from __future__ import annotations

import os
import shutil
from pathlib import Path


TEST_DB = Path("/private/tmp/room_design_mvp_test.db")
TEST_ARTIFACTS = Path("/private/tmp/room_design_mvp_test_artifacts")
TEST_DB.unlink(missing_ok=True)
shutil.rmtree(TEST_ARTIFACTS, ignore_errors=True)

os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB}"
os.environ["ARTIFACT_DIR"] = str(TEST_ARTIFACTS)
os.environ["BLENDER_ENABLED"] = "false"

