# Modelo de segurança da auditoria

Esta nota é voltada a quem desenvolve, opera ou avalia o serviço. A interface pública explica o resultado da conferência em linguagem simples e não substitui esta análise técnica.

## Garantias implementadas

Cada lance registra lote, sequência, participante interno, valor em centavos, horário, hash anterior e hash do próprio evento. O hash do evento usa SHA-256. A tabela `audit_heads` armazena a sequência esperada, o hash final e uma assinatura HMAC-SHA-256 gerada com `AUDIT_SECRET`; essa cabeça é atualizada na mesma transação que grava o lance.

Na consulta, o serviço recalcula os hashes e a sequência, confere a quantidade de eventos, compara o hash final e valida a assinatura. A verificação detecta mudanças nos dados dos eventos, remoções ou inserções, alteração de ordem e alterações na cabeça assinada. Se a cabeça estiver ausente, o resultado é inconclusivo e a interface não declara o histórico verificado.

## Limites e modelo de ameaça

A assinatura ajuda a detectar alterações no banco quando `AUDIT_SECRET` permanece privado e estável. Se alguém obtiver controle simultâneo do banco e do segredo, poderá recalcular a cadeia e produzir assinaturas válidas. A cabeça não é ancorada em serviço externo, módulo de segurança de hardware ou log independente; portanto, o modelo não prova autoria contra um administrador que também controle o segredo.

Preserve o mesmo `AUDIT_SECRET` durante toda a vida do banco e proteja suas cópias de backup. A rotação ou perda do segredo exige um plano de migração da auditoria; trocar o valor sem esse plano torna os históricos existentes inválidos ou inconclusivos.

## Privacidade

Os registros públicos usam pseudônimos. E-mail, hash de senha e token de sessão não fazem parte dos eventos de auditoria nem dos recibos públicos.
