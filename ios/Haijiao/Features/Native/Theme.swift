//
//  Theme.swift
//  Haijiao
//
//  ⚠️ 原站是**浅色**主题（实测 body = rgb(255,255,255)，文字 rgb(53,53,53)，卡片圆角 4px）。
//  之前几版按深色做、还把黑色一路调深，方向完全反了 —— 用户说的「背景全黑」就是这个意思。
//

import SwiftUI

enum Theme {
    /// 页面底色（原站纯白）
    static let canvas = Color.white
    /// 卡片（白底，靠分割线和间距区分）
    static let card = Color.white
    /// 卡片按下态
    static let cardPressed = Color(red: 0.96, green: 0.96, blue: 0.965)
    /// 分割线 / 描边（浅灰）
    static let stroke = Color.black.opacity(0.08)
    /// 主文字 #353535
    static let text = Color(red: 0.208, green: 0.208, blue: 0.208)
    /// 次要文字
    static let subtext = Color(red: 0.52, green: 0.52, blue: 0.55)
    /// 强调色（角标/高亮）
    static let accent = Color(red: 0.90, green: 0.24, blue: 0.29)
    /// 标签底色
    static let chip = Color.black.opacity(0.05)
    /// 分割线
    static let divider = Color.black.opacity(0.08)
    /// 图片占位（浅灰）
    static let placeholder = Color(red: 0.95, green: 0.95, blue: 0.96)
}
