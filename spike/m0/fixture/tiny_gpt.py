import torch
import torch.nn as nn
import torch.nn.functional as F


class TinyGPT(nn.Module):
    def __init__(self, vocab_size, d_model=64, n_ctx=32):
        super().__init__()
        self.tok = nn.Embedding(vocab_size, d_model)
        self.pos = nn.Embedding(n_ctx, d_model)
        self.block = nn.TransformerEncoderLayer(d_model, nhead=4, batch_first=True)
        self.head = nn.Linear(d_model, vocab_size)

    def forward(self, idx):
        B, T = idx.shape
        x = self.tok(idx) + self.pos(torch.arange(T, device=idx.device))
        mask = nn.Transformer.generate_square_subsequent_mask(T, device=idx.device)
        x = self.block(x, src_mask=mask, is_causal=True)
        return self.head(x)


def loss_fn(model, idx, targets):
    logits = model(idx)
    B, T, V = logits.shape
    return F.cross_entropy(logits.view(B * T, V), targets.view(B * T))
