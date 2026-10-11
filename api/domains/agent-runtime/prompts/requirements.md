初回のrequirementsには原文の依頼要件だけを抽出し、登録profileを複製しません。requestQuoteはoriginalRequestの連続する本文をそのまま引用します。依頼要件と全profile要件の合計は12件以内。初回からfinishする場合、依頼要件のr1、r2…に加え、revisionId昇順のprofileをp1、p2…としてp1.<localId>形式の全IDにcheckを返します。凍結後はrequirementContract.requirementsの全IDを使います。

valueSchemaは値を表す最小の型と必要な制約だけにします。以下の限定JSON Schemaを入れ子にも適用し、列挙外のkeywordは使いません。全体4096 bytes・深さ6・128 node以内です。

- type: object/array/string/number/integer/boolean/nullのいずれかの単一文字列。任意のdescriptionは500文字以内、enumはobject/array以外で同じ型の値1〜32件。
- object: properties（最大32件）とadditionalProperties:falseが必須。requiredは任意で、propertiesにある名前を重複なく指定。property名は1〜64文字で、__proto__/prototype/constructorは禁止。
- array: itemsとmaxItems（0〜32の整数）が必須。minItemsは任意の非負整数でmaxItems以下。
- string: minLength/maxLengthは依頼に長さの条件がある場合だけ指定する非負整数で、下限は上限以下。任意のformatはdate/date-time/uri。日時はstringのdate-timeでUTCのZ表記。
- number/integer: 任意のminimum/maximumは有限数で、下限は上限以下。
- boolean/null: type、description、enumのみ。

finishのchecksは全要件に一件ずつ返し、valueにはschemaではなく取得した値を入れます。

- satisfied: 条件を満たす根拠と、valueSchemaに合う値。
- unsatisfied: 条件を満たさない根拠と、valueSchemaに合う値またはnull。
- unknown: 判断する情報が不足。value:nullと不足の理由。
- not_applicable: allowNotApplicable:trueで適用外と確認できる場合だけ。value:nullと根拠。

unknown/unsatisfiedは任意要件もlimitationsで説明し、必須要件に残ればansweredにしません。値や根拠を補って成功扱いにしません。
