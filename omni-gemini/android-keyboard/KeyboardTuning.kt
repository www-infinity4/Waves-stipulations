package com.infinity.clipboard.keyboard.settings

data class ResponseWeights(
    val tapDebounceMs: Int = 28,
    val keyCommitDelayMs: Int = 0,
    val longPressThresholdMs: Int = 420,
    val backspaceRepeatDelayMs: Int = 360,
    val backspaceRepeatRateMs: Int = 55,
    val animationDurationMs: Int = 70,
    val hapticStrengthPercent: Int = 45,
    val soundVolumePercent: Int = 0,
) {
    init {
        require(tapDebounceMs in 0..250)
        require(keyCommitDelayMs in 0..500)
        require(longPressThresholdMs in 200..1200)
        require(backspaceRepeatDelayMs in 150..1000)
        require(backspaceRepeatRateMs in 20..300)
        require(animationDurationMs in 0..500)
        require(hapticStrengthPercent in 0..100)
        require(soundVolumePercent in 0..100)
    }
}

data class ContextWeights(
    val currentSentence: Int = 100,
    val previousSentences: Int = 85,
    val documentTopic: Int = 78,
    val conversationIntent: Int = 82,
    val personalVocabulary: Int = 88,
    val recentPhraseReuse: Int = 52,
    val grammarFit: Int = 76,
    val semanticFit: Int = 100,
    val frequencyPrior: Int = 32,
    val lengthPenalty: Int = 45,
    val repetitionPenalty: Int = 72,
    val confidenceThreshold: Int = 68,
) {
    init {
        this::class.java.declaredFields
            .filter { it.type == Int::class.javaPrimitiveType }
            .forEach { field ->
                field.isAccessible = true
                require(field.getInt(this) in 0..100) { "${field.name} must be 0..100" }
            }
    }
}

enum class KeyboardProfile {
    INSTANT,
    CAREFUL,
    LONG_FORM,
    CODE,
    CUSTOM,
}

data class KeyboardTuning(
    val profile: KeyboardProfile = KeyboardProfile.LONG_FORM,
    val response: ResponseWeights = ResponseWeights(),
    val context: ContextWeights = ContextWeights(),
    val glideTypingEnabled: Boolean = false,
) {
    init {
        require(!glideTypingEnabled) {
            "Infinity Clipboard Keyboard intentionally does not support glide typing"
        }
    }
}
