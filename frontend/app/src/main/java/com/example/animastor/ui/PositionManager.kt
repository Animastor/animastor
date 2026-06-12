package com.example.animastor.ui

import com.example.animastor.repository.SceneUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object SharedPositionManager {

    private val _current = MutableStateFlow(ActivePosition())
    val current: StateFlow<ActivePosition> = _current.asStateFlow()

    fun navigateTo(position: ActivePosition) {
        _current.value = position
    }

    fun navigateTo(
        chapterId: String?,
        sceneId: String?,
        unitId: String? = null,
        chunkId: String? = null,
        unitIndex: Int = 0
    ) {
        _current.value = ActivePosition(
            chapterId = chapterId,
            sceneId = sceneId,
            unitId = unitId,
            chunkId = chunkId,
            unitIndex = unitIndex
        )
    }

    fun previousUnit(sceneUnits: List<SceneUnit>) {
        val pos = _current.value
        val idx = pos.unitIndex
        if (idx > 0) {
            val newIdx = idx - 1
            _current.value = pos.copy(
                unitId = sceneUnits.getOrNull(newIdx)?.id,
                unitIndex = newIdx
            )
        }
    }

    fun nextUnit(sceneUnits: List<SceneUnit>) {
        val pos = _current.value
        val idx = pos.unitIndex
        if (idx < sceneUnits.size - 1) {
            val newIdx = idx + 1
            _current.value = pos.copy(
                unitId = sceneUnits.getOrNull(newIdx)?.id,
                unitIndex = newIdx
            )
        }
    }
}
