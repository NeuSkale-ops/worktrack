fn main() {
    println!("cargo:rerun-if-changed=src/location_macos.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let object = out.join("location_macos.o");
        let archive = out.join("libworktrack_location.a");
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            other => panic!("Unsupported macOS architecture: {other}"),
        };
        let status = std::process::Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-fblocks",
                "-arch",
                arch,
                "-mmacosx-version-min=11.0",
                "-c",
                "src/location_macos.m",
                "-o",
            ])
            .arg(&object)
            .status()
            .expect("Xcode command line tools are required");
        assert!(status.success(), "CoreLocation bridge compilation failed");
        let status = std::process::Command::new("xcrun")
            .args(["ar", "crs"])
            .arg(&archive)
            .arg(&object)
            .status()
            .unwrap();
        assert!(status.success(), "CoreLocation bridge archive failed");
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=worktrack_location");
        println!("cargo:rustc-link-lib=framework=CoreLocation");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
    tauri_build::build()
}
