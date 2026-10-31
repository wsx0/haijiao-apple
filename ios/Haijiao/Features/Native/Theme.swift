//
//  Theme.swift
//  Haijiao
//
//  配色对齐网页版：需要能看出「底 / 卡片 / 描边」三层，不能一坨黑。
//  上一版 canvas #0E0E10 太接近纯黑，用户反馈「还是全黑」。
//

import SwiftUI

enum Theme {
    /// 页面底色（深灰，不是纯黑）
    static let canvas = Color(red: 0.090, green: 0.090, blue: 0.102)      // #17171A
    /// 卡片（明显比底色亮一级）
    static let card = Color(red: 0.137, green: 0.137, blue: 0.153)        // #232327
    /// 卡片按下态
    static let cardPressed = Color(red: 0.176, green: 0.176, blue: 0.196) // #2D2D32
    /// 卡片描边
    static let stroke = Color.white.opacity(0.09)
    /// 主文字
    static let text = Color(red: 0.94, green: 0.94, blue: 0.96)
    /// 次要文字
    static let subtext = Color(red: 0.66, green: 0.66, blue: 0.70)
    /// 强调色（网页版角标偏暖橙）
    static let accent = Color(red: 0.98, green: 0.58, blue: 0.28)
    /// 标签底色
    static let chip = Color.white.opacity(0.10)
    /// 分割线
    static let divider = Color.white.opacity(0.08)
}
