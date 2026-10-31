//
//  LoginView.swift
//  Haijiao
//
//  App 内登录。密码只在本机输入、只发给 haijiao.com，不经过任何第三方。
//
//  接口（实测）：POST /api/login/signin
//    body: { username, password }        ← 验证码实测非必需（不带 captcha 也只报「用户不存在」）
//    成功：返回 token，之后请求带 x-user-id / x-user-token
//    失败：{ isEncrypted:false, success:false, message:"用户不存在"/"密码错误" }
//

import SwiftUI

struct LoginView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var username = UserDefaults.standard.string(forKey: "hj.username") ?? ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    /// 登录成功回调（uid, token）
    var onSuccess: (Int, String) -> Void

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("用户名 / 邮箱", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                    SecureField("密码", text: $password)
                        .textContentType(.password)
                } header: {
                    Text("账号")
                } footer: {
                    Text("密码只发送给 haijiao.com，存在本机钥匙串外的地方仅限 UserDefaults。列表接口会带上登录态，视频地址可能因此出现。")
                        .font(.system(size: 11))
                }

                if let e = error {
                    Section {
                        Text(e)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView().scaleEffect(0.8) }
                            Text(busy ? "登录中…" : "登录")
                                .font(.system(size: 15, weight: .semibold))
                            Spacer()
                        }
                    }
                    .disabled(busy || username.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                }
            }
            .navigationTitle("登录海角")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("取消") { dismiss() }
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private func submit() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let (uid, token) = try await TopicAPI.login(username: username, password: password)
            UserDefaults.standard.set(username, forKey: "hj.username")
            UserDefaults.standard.set(uid, forKey: "hj.uid")
            UserDefaults.standard.set(token, forKey: "hj.token")
            onSuccess(uid, token)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
