package com.example.animastor.ui

import android.content.res.ColorStateList
import android.graphics.Typeface
import android.text.InputType
import android.util.TypedValue
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.repository.AuthStore
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.launch
import org.json.JSONObject
import retrofit2.HttpException

/**
 * Authentication dialog — web parity with features/auth/UserMenu.tsx
 * AuthDialog/UserMenu. Two ways to reach it (one dialog, like the web):
 *
 *  - anonymous (`authenticated == false`): Login / Create account form with
 *    a mode switch button ("No account? Sign up" ↔ "Have an account? Sign in")
 *    and the registration hint "Keep your work forever";
 *  - authenticated: username + personal workspace + Sign out.
 *
 * The session itself is an HttpOnly cookie kept by
 * [com.example.animastor.network.PersistentCookieJar] — this dialog never
 * touches tokens directly, it only calls the auth endpoints and refreshes
 * [AuthStore].
 */
object AuthDialog {

    private enum class Mode { LOGIN, REGISTER }

    /**
     * Show the auth dialog for the current [AuthStore] state.
     * [onAuthChanged] fires after a successful login/register/logout so the
     * caller can refresh dependent state.
     */
    fun show(activity: FragmentActivity, onAuthChanged: () -> Unit = {}) {
        fun dp(v: Int) = (v * activity.resources.displayMetrics.density + 0.5f).toInt()

        val me = AuthStore.state.value

        if (me.authenticated && me.user != null) {
            showAccountPanel(activity, onAuthChanged, ::dp)
            return
        }
        showAuthForm(activity, Mode.LOGIN, onAuthChanged, ::dp)
    }

    // ── authenticated panel: username + workspace + logout ─────────────

    private fun showAccountPanel(activity: FragmentActivity, onAuthChanged: () -> Unit, dp: (Int) -> Int) {
        val me = AuthStore.state.value

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(8))
        }

        root.addView(TextView(activity).apply {
            text = me.user?.username ?: ""
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
        })
        me.workspace?.let { ws ->
            root.addView(TextView(activity).apply {
                text = activity.getString(R.string.auth_personal_workspace)
                textSize = 13f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, dp(4), 0, 0)
            })
            if (!ws.name.isNullOrBlank()) {
                root.addView(TextView(activity).apply {
                    text = ws.name
                    textSize = 13f
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                    setPadding(0, dp(2), 0, 0)
                })
            }
        }

        val dialog = AlertDialog.Builder(activity).setView(root).create()
        applyDialogSurface(activity, dialog)

        val logout = MaterialButton(
            activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle
        ).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(16) }
            text = activity.getString(R.string.auth_logout)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            strokeColor = ColorStateList.valueOf(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            setOnClickListener {
                activity.lifecycleScope.launch {
                    AuthStore.logout()
                    dialog.dismiss()
                    onAuthChanged()
                }
            }
        }
        root.addView(logout)
        dialog.show()
    }

    // ── login / register form ──────────────────────────────────────────

    private fun showAuthForm(activity: FragmentActivity, initialMode: Mode, onAuthChanged: () -> Unit, dp: (Int) -> Int) {
        var mode = initialMode

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(4))
        }

        val title = TextView(activity).apply {
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            setPadding(0, 0, 0, dp(12))
        }

        val usernameLayout = outlinedField(activity, R.string.auth_username)
        val usernameInput = usernameLayout.editText as TextInputEditText
        usernameInput.inputType = InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD

        val passwordLayout = outlinedField(activity, R.string.auth_password)
        val passwordInput = passwordLayout.editText as TextInputEditText
        passwordInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD

        val emailLayout = outlinedField(activity, R.string.auth_email_optional)
        val emailInput = emailLayout.editText as TextInputEditText
        emailInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS

        val emailHint = TextView(activity).apply {
            text = activity.getString(R.string.auth_email_hint)
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
        }

        val registerHint = TextView(activity).apply {
            text = activity.getString(R.string.auth_register_hint)
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setPadding(0, dp(8), 0, 0)
        }

        val errorView = TextView(activity).apply {
            textSize = 13f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            visibility = View.GONE
            setPadding(0, dp(8), 0, 0)
        }

        val dialog = AlertDialog.Builder(activity).create()
        applyDialogSurface(activity, dialog)

        val switchButton = MaterialButton(
            activity, null, com.google.android.material.R.attr.borderlessButtonStyle
        ).apply {
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary))
        }

        val submit = MaterialButton(activity).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f)
        }
        val cancel = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginEnd = dp(8) }
            text = activity.getString(R.string.dialog_cancel)
            setOnClickListener { dialog.dismiss() }
        }

        val footer = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(16), 0, dp(8))
            addView(cancel)
            addView(submit)
        }

        val applyMode = {
            val isRegister = mode == Mode.REGISTER
            title.text = activity.getString(if (isRegister) R.string.auth_register else R.string.auth_login)
            emailLayout.visibility = if (isRegister) View.VISIBLE else View.GONE
            emailHint.visibility = if (isRegister) View.VISIBLE else View.GONE
            registerHint.visibility = if (isRegister) View.VISIBLE else View.GONE
            switchButton.text = activity.getString(if (isRegister) R.string.auth_switch_to_login else R.string.auth_switch_to_register)
            submit.text = activity.getString(if (isRegister) R.string.auth_register else R.string.auth_login)
            errorView.visibility = View.GONE
        }

        switchButton.setOnClickListener {
            mode = if (mode == Mode.LOGIN) Mode.REGISTER else Mode.LOGIN
            applyMode()
        }

        submit.setOnClickListener {
            if (AuthStore.busy.value) return@setOnClickListener
            val username = (usernameInput.text ?: "").toString().trim()
            val password = (passwordInput.text ?: "").toString()
            val email = (emailInput.text ?: "").toString().trim()

            // Server is authoritative for policy; the client only blocks
            // obviously-empty submits (web parity: native `required`).
            if (username.isEmpty() || password.isEmpty()) {
                errorView.text = activity.getString(R.string.auth_error)
                errorView.visibility = View.VISIBLE
                return@setOnClickListener
            }

            submit.isEnabled = false
            errorView.visibility = View.GONE
            activity.lifecycleScope.launch {
                try {
                    if (mode == Mode.REGISTER) AuthStore.register(username, password, email.ifEmpty { null })
                    else AuthStore.login(username, password)
                    dialog.dismiss()
                    onAuthChanged()
                } catch (e: Throwable) {
                    errorView.text = friendlyError(e, activity)
                    errorView.visibility = View.VISIBLE
                } finally {
                    submit.isEnabled = true
                }
            }
        }

        root.addView(title)
        root.addView(fieldBlock(usernameLayout, dp))
        root.addView(fieldBlock(passwordLayout, dp))
        root.addView(fieldBlock(emailLayout, dp))
        root.addView(emailHint)
        root.addView(registerHint)
        root.addView(errorView)
        root.addView(switchButton)
        root.addView(footer)

        val scroll = ScrollView(activity).apply { addView(root) }
        dialog.setView(scroll)
        applyMode()
        dialog.show()
        usernameInput.requestFocus()
    }

    // ── helpers ────────────────────────────────────────────────────────

    private fun outlinedField(activity: FragmentActivity, labelRes: Int): TextInputLayout {
        val layout = TextInputLayout(
            activity, null, com.google.android.material.R.attr.textInputOutlinedStyle
        ).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            hint = activity.getString(labelRes)
            addView(TextInputEditText(activity).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            })
        }
        return layout
    }

    private fun fieldBlock(field: TextInputLayout, dp: (Int) -> Int): LinearLayout {
        return LinearLayout(field.context).apply {
            orientation = LinearLayout.VERTICAL
            addView(field)
        }.also { it.setPadding(0, 0, 0, dp(4)) }
    }

    /** Match the web modal surface (AppDialogs uses the same recipe). */
    private fun applyDialogSurface(activity: FragmentActivity, dialog: AlertDialog) {
        val dm = activity.resources.displayMetrics
        fun dp(v: Int) = (v * dm.density + 0.5f).toInt()
        dialog.window?.setBackgroundDrawable(
            android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(MaterialColors.getColor(dialog.window!!.decorView, com.google.android.material.R.attr.colorSurface))
                setStroke(dp(1), MaterialColors.getColor(dialog.window!!.decorView, com.google.android.material.R.attr.colorOutlineVariant))
            }
        )
    }

    /** Backend returns { error: "..." } on auth failures. */
    private fun friendlyError(e: Throwable, activity: FragmentActivity): String {
        if (e is HttpException) {
            val body = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            if (body != null) {
                val msg = runCatching { JSONObject(body).optString("error").ifEmpty { null } }.getOrNull()
                if (msg != null) return msg
            }
        }
        return e.message ?: activity.getString(R.string.auth_error)
    }
}
