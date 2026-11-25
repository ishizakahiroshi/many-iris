#[path = "src/windows_resource.rs"]
mod windows_resource;

use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let repo_root = manifest_dir.parent().unwrap();

    println!("cargo:rerun-if-changed=src/windows_resource.rs");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    let icon_path = repo_root.join("assets/icons/favicon.ico");
    let manifest_path = manifest_dir.join("app.manifest");
    println!("cargo:rerun-if-changed={}", icon_path.display());
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let icon = fs::read(&icon_path).expect("read assets/icons/favicon.ico");
    let manifest = fs::read(&manifest_path).expect("read app.manifest");
    let resource =
        windows_resource::build_windows_resource(&icon, &manifest).expect("build .res resource");
    let out_path = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("many-iris-picker.res");
    fs::write(&out_path, resource).expect("write .res resource");
    println!(
        "cargo:rustc-link-arg-bin=many-iris-picker={}",
        out_path.display()
    );
}
