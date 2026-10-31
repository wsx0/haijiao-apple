//
//  Theme.swift
//  Haijiao
//
//  配色对齐网页版：页面深灰底、卡片浅一级、描边非常轻。
//  之前是纯黑（Color.black + List 默认样式），看起来跟站点差得远。
//

import SwiftUI

enum Theme {
    /// 页面底色（比纯黑柔一点）
    static let canvas = Color(red: 0.055, green: 0.055, blue: 0.063)
    /// 卡片/列表行底色
    static let card = Color(red: 0.110, green: 0.110, blue: 0.122)
    /// 卡片描边
    static let stroke = Color.white.opacity(0.06)
    /// 主文字
    static let text = Color(red: 0.93, green: 0.93, blue: 0.94)
    /// 次要文字
    static let subtext = Color(red: 0.62, green: 0.62, blue: 0.66)
    /// 强调色（网页版主色偏暖橙）
    static let accent = Color(red: 0.98, green: 0.55, blue: 0.24)
    /// 标签底色
    static let chip = Color.white.opacity(0.08)
}
