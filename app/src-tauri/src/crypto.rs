const IMG_XOR: u8 = 0x5A;

/// PNG バイト列を XOR スクランブルして .gti 形式に変換する。復元も同関数で行える。
pub fn scramble_image(data: &[u8]) -> Vec<u8> {
    data.iter().map(|b| b ^ IMG_XOR).collect()
}
