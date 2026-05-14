import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from news_digest import build_selector_options

def test_github_options():
    data = {
        "groups": [{"items": [
            {"name": "harness/harness", "url": "https://github.com/harness/harness", "summary": "CI/CD platform"},
            {"name": "harness/gitness", "url": "https://github.com/harness/gitness", "summary": "Git hosting"},
        ]}],
        "blog_group": {"items": []},
    }
    opts = build_selector_options(data)
    assert len(opts) == 2
    assert opts[0]["value"] == "github:harness/harness"
    assert opts[0]["label"] == "[GitHub] harness/harness"
    assert len(opts[0]["label"]) <= 100
    assert len(opts[0]["value"]) <= 100

def test_blog_options():
    data = {
        "groups": [],
        "blog_group": {"items": [
            {"name": "Claude 3.7 Sonnet", "url": "https://www.anthropic.com/news/claude-3-7-sonnet", "summary": "New model", "source": "Anthropic"},
        ]},
    }
    opts = build_selector_options(data)
    assert len(opts) == 1
    assert opts[0]["value"] == "blog:https://www.anthropic.com/news/claude-3-7-sonnet"
    assert len(opts[0]["value"]) <= 100

def test_max_25_options():
    items = [{"name": f"owner/repo{i}", "url": f"https://github.com/owner/repo{i}", "summary": "s"} for i in range(30)]
    data = {"groups": [{"items": items}], "blog_group": {"items": []}}
    opts = build_selector_options(data)
    assert len(opts) == 25

def test_skips_items_without_url():
    data = {
        "groups": [{"items": [{"name": "no-url", "summary": "x"}]}],
        "blog_group": {"items": []},
    }
    opts = build_selector_options(data)
    assert len(opts) == 0
