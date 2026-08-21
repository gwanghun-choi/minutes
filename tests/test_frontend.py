"""The two front-end contracts that are worth pinning without a browser.

Both exist because of real bugs. The scope dialog was permanently on screen —
`.modal { display: flex }` is an author rule and outranks the browser's own
`[hidden] { display: none }`, so the `hidden` attribute the JavaScript toggles
did nothing at all, and neither ✕ nor 선택 완료 could close anything.
"""
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
CSS = (APP / "static" / "app.css").read_text(encoding="utf-8")
JS = (APP / "static" / "app.js").read_text(encoding="utf-8")
CHAT = (APP / "templates" / "chat.html").read_text(encoding="utf-8")
MEETING = (APP / "templates" / "meeting.html").read_text(encoding="utf-8")


def test_the_hidden_attribute_actually_hides_the_modal():
    """Without this rule the dialog is visible from page load and never closes."""
    assert ".modal[hidden] { display: none; }" in CSS


def test_every_way_out_of_the_modal_goes_through_one_close_function():
    """✕, the backdrop, and ESC share a single path, so they cannot drift apart."""
    assert JS.count("const closeScope = ") == 1
    assert '$("#scope-close").onclick = closeScope;' in JS
    assert "if (e.target === modal) closeScope();" in JS
    assert 'e.key === "Escape"' in JS
    # exactly one place sets it back to visible
    assert JS.count("modal.hidden = false;") == 1


def test_the_scope_is_only_applied_after_the_server_accepts_it():
    """A failed PATCH must leave the dialog open and the chat's scope untouched."""
    apply_block = JS[JS.index('$("#scope-apply").onclick'):JS.index("const preset =")]
    assert apply_block.index("await api(") < apply_block.index("scope = next;")
    assert "closeScope();" in apply_block
    assert "범위 저장 실패: " in apply_block


def test_the_picker_is_a_checkbox_list_so_several_meetings_can_be_chosen():
    assert 'type="checkbox"' in JS
    assert "picked.add(Number(box.value))" in JS
    assert '`선택한 회의 ${scope.length}개`' in JS


def test_the_modal_has_the_elements_the_script_drives():
    for element in ("scope-modal", "scope-close", "scope-apply", "scope-msg",
                    "scope-search", "scope-options"):
        assert f'id="{element}"' in CHAT


def test_the_meeting_date_can_be_seen_and_corrected_without_a_date_library():
    """A native input, and the 2s poll must not overwrite it mid-edit."""
    for element in ("m-held", "held-btn", "held-msg"):
        assert f'id="{element}"' in MEETING
    assert 'type="datetime-local"' in MEETING
    assert 'document.activeElement !== $("#m-held")' in JS
    assert "/held-at" in JS
